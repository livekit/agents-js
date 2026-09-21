// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { ConnectTwilioCallResponse } from '@livekit/protocol';
import { ParticipantKind, type RemoteParticipant, Room, TrackKind } from '@livekit/rtc-node';
import { AccessToken, ConnectorClient } from 'livekit-server-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as job from '../job.js';
import type { JobContext } from '../job.js';
import { log } from '../log.js';
import { AgentSession } from '../voice/agent_session.js';
import { BackgroundAudioPlayer } from '../voice/background_audio.js';
import { createTwilioConnectorWarmTransferTask } from './warm_transfer.js';

const CALLER_NUMBER = '+15555550101';
const TWILIO_NUMBER = '+15555550102';
const HUMAN_NUMBER = '+15555550103';
const CALL_TOKEN = 'opaque-call-token+with/encoding==';
const CONNECT_URL = 'wss://connector.example.test/stream?one=1&two=2';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/** `Response` bodies are single-use, so every fetch needs a freshly built one. */
const responds = (body: string, init?: ResponseInit) => () =>
  Promise.resolve(new Response(body, init));

interface SetupOptions {
  callToken?: string;
  originalCallerNumber?: string;
  /** Whether the connector publishes the human agent's audio on room connect. */
  answered?: boolean;
  /** Left comfortably long unless a test needs the no-answer timeout to fire. */
  ringingTimeout?: number;
  abortSignal?: AbortSignal;
}

function setupTransfer(options: SetupOptions = {}) {
  const {
    callToken,
    originalCallerNumber = CALLER_NUMBER,
    answered = true,
    ringingTimeout = 5000,
    abortSignal,
  } = options;
  vi.stubEnv('LIVEKIT_API_KEY', 'api-key');
  vi.stubEnv('LIVEKIT_API_SECRET', 'api-secret');
  vi.spyOn(AccessToken.prototype, 'toJwt').mockResolvedValue('token');
  vi.spyOn(Room.prototype, 'connect').mockImplementation(async function () {
    Object.defineProperty(this, 'name', { value: 'consult-room' });
    Object.defineProperty(this, 'isConnected', { get: () => true });
    if (answered) {
      this.remoteParticipants.set('human-agent-connector', {
        identity: 'human-agent-connector',
        trackPublications: new Map([['audio', { kind: TrackKind.KIND_AUDIO }]]),
      } as RemoteParticipant);
    }
  });
  vi.spyOn(Room.prototype, 'disconnect').mockResolvedValue();
  vi.spyOn(AgentSession.prototype, 'start').mockResolvedValue();
  vi.spyOn(AgentSession.prototype, 'shutdown').mockImplementation(() => {});
  vi.spyOn(AgentSession.prototype, 'close').mockResolvedValue();
  vi.spyOn(BackgroundAudioPlayer.prototype, 'close').mockResolvedValue();
  const logger = log();
  const logError = vi.spyOn(logger, 'error');
  const logWarn = vi.spyOn(logger, 'warn');
  const connect = vi
    .spyOn(ConnectorClient.prototype, 'connectTwilioCall')
    .mockResolvedValue(new ConnectTwilioCallResponse({ connectUrl: CONNECT_URL }));
  const fetch = vi.fn().mockImplementation(responds(JSON.stringify({ sid: 'CA_test_transfer' })));
  vi.stubGlobal('fetch', fetch);

  const callerRoom = {
    name: 'caller-room',
    localParticipant: { identity: 'transfer-agent' },
    remoteParticipants: new Map([
      ['caller', { identity: 'caller', kind: ParticipantKind.CONNECTOR }],
    ]),
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as Room;
  const task = createTwilioConnectorWarmTransferTask({
    phoneNumber: HUMAN_NUMBER,
    twilioFromNumber: TWILIO_NUMBER,
    originalCallerNumber,
    twilioCallToken: callToken,
    twilioAccountSid: 'AC_test_account',
    twilioAuthToken: 'test_auth_token',
    ringingTimeout,
    abortSignal,
    holdAudio: null,
  });
  task._agentActivity = { agentSession: new AgentSession() } as never;
  const complete = vi.spyOn(task, 'complete').mockImplementation(() => {});
  const enter = () =>
    job.runWithJobContextAsync(
      {
        room: callerRoom,
        info: { url: 'wss://example.livekit.cloud', apiKey: 'api-key', apiSecret: 'api-secret' },
      } as JobContext,
      () => task.onEnter(),
    );
  return { task, connect, fetch, complete, logError, logWarn, enter };
}

/**
 * The dial failure reaches `complete` as a generic tool error; the underlying
 * cause is only visible on the log record, so assert its exact message there.
 */
function expectDialFailure(
  ctx: ReturnType<typeof setupTransfer>,
  message: string | ReturnType<typeof expect.stringContaining>,
) {
  expect(ctx.complete).toHaveBeenCalledWith(
    expect.objectContaining({ message: 'could not dial human agent' }),
  );
  expect(ctx.logError).toHaveBeenCalledWith(
    expect.objectContaining({ error: expect.objectContaining({ message }) }),
    'could not dial human agent',
  );
}

const formOf = (fetch: ReturnType<typeof vi.fn>, index: number) =>
  new URLSearchParams(fetch.mock.calls[index]![1].body.toString());

describe('Twilio connector CallToken forwarding', () => {
  it.each([undefined, CALL_TOKEN])('preserves caller ID with token %s', async (callToken) => {
    const ctx = setupTransfer({ callToken });
    const { task, connect, fetch, complete, enter } = ctx;

    await enter();

    expect(complete).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledOnce();
    const [url, request] = fetch.mock.calls[0]!;
    expect(url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC_test_account/Calls.json');
    expect(request.method).toBe('POST');
    const form = formOf(fetch, 0);
    expect(form.get('To')).toBe(HUMAN_NUMBER);
    expect(form.get('From')).toBe(callToken === undefined ? TWILIO_NUMBER : CALLER_NUMBER);
    expect(form.get('CallToken')).toBe(callToken ?? null);
    expect(form.get('Twiml')).toContain('one=1&amp;two=2');
    expect(form.get('Twiml')).not.toContain(CALL_TOKEN);
    expect(JSON.stringify(connect.mock.calls)).not.toContain(CALL_TOKEN);
    expect(task.instructions).not.toContain(CALL_TOKEN);
    expect(JSON.stringify(task.chatCtx.toJSON())).not.toContain(CALL_TOKEN);
  });

  it('does not retry an unrelated rejection', async () => {
    const ctx = setupTransfer({ callToken: CALL_TOKEN });
    ctx.fetch.mockImplementation(responds('{"message":"Invalid CallToken"}', { status: 403 }));

    await ctx.enter();

    expect(ctx.fetch).toHaveBeenCalledOnce();
    expectDialFailure(ctx, 'Twilio call creation failed (403, code unknown)');
  });

  it('cancels an unanswered forwarded call without reusing the token in the cancellation', async () => {
    const ctx = setupTransfer({ callToken: CALL_TOKEN, answered: false, ringingTimeout: 10 });

    await ctx.enter();

    expect(ctx.fetch).toHaveBeenCalledTimes(2);
    const [url, request] = ctx.fetch.mock.calls[1]!;
    expect(url).toBe(
      'https://api.twilio.com/2010-04-01/Accounts/AC_test_account/Calls/CA_test_transfer.json',
    );
    expect(Object.fromEntries(new URLSearchParams(request.body.toString()))).toEqual({
      Status: 'canceled',
    });
    expectDialFailure(ctx, 'human agent did not answer');
  });

  it('propagates the wait error when the cancellation itself fails', async () => {
    const ctx = setupTransfer({ callToken: CALL_TOKEN, answered: false, ringingTimeout: 10 });
    ctx.fetch
      .mockImplementationOnce(responds(JSON.stringify({ sid: 'CA_test_transfer' })))
      .mockImplementationOnce(responds('{"message":"server error"}', { status: 500 }));

    await ctx.enter();

    expect(ctx.fetch).toHaveBeenCalledTimes(2);
    // The cancel failure is logged without a body, SID or number, and swallowed.
    expect(ctx.logWarn).toHaveBeenCalledWith({ status: 500 }, 'failed to cancel Twilio call');
    expect(ctx.logWarn).toHaveBeenCalledOnce();
    expectDialFailure(ctx, 'human agent did not answer');
  });

  it('reports cancellation transport failures without logging request data', async () => {
    const ctx = setupTransfer({ callToken: CALL_TOKEN, answered: false, ringingTimeout: 10 });
    ctx.fetch
      .mockImplementationOnce(responds('{"sid":"CA_test_transfer"}'))
      .mockRejectedValueOnce(new Error(`request failed: ${CALL_TOKEN} ${CALLER_NUMBER}`));
    await ctx.enter();
    expect(ctx.logWarn).toHaveBeenCalledExactlyOnceWith(
      'failed to cancel Twilio call: request failed',
    );
    expect(JSON.stringify(ctx.logWarn.mock.calls)).not.toContain(CALL_TOKEN);
    expect(JSON.stringify(ctx.logWarn.mock.calls)).not.toContain(CALLER_NUMBER);
    expectDialFailure(ctx, 'human agent did not answer');
  });
});

describe('Twilio caller-ID fallback', () => {
  it.each([false, true])('retries only once; second failure=%s', async (secondFailure) => {
    const ctx = setupTransfer({ callToken: CALL_TOKEN });
    const { fetch, connect, complete, enter } = ctx;
    fetch.mockImplementationOnce(responds('{"code":21210}', { status: 400 }));
    if (secondFailure) {
      fetch.mockImplementationOnce(responds('{"code":21210}', { status: 400 }));
    }
    await enter();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(connect).toHaveBeenCalledOnce();
    const first = formOf(fetch, 0);
    const second = formOf(fetch, 1);
    expect(first.get('From')).toBe(CALLER_NUMBER);
    expect(first.get('CallToken')).toBe(CALL_TOKEN);
    expect(second.get('From')).toBe(TWILIO_NUMBER);
    expect(second.has('CallToken')).toBe(false);
    expect(second.get('Twiml')).toBe(first.get('Twiml'));
    if (secondFailure) expectDialFailure(ctx, 'Twilio call creation failed (400, code 21210)');
    else expect(complete).not.toHaveBeenCalled();
  });

  it('retries once for an invalid inbound caller ID (21212)', async () => {
    const ctx = setupTransfer({ callToken: CALL_TOKEN, originalCallerNumber: 'anonymous' });
    const { fetch, connect, complete, enter } = ctx;
    fetch.mockImplementationOnce(responds('{"code":21212}', { status: 400 }));
    await enter();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(connect).toHaveBeenCalledOnce();
    expect(formOf(fetch, 0).get('CallToken')).toBe(CALL_TOKEN);
    expect(formOf(fetch, 0).get('From')).toBe('anonymous');
    const second = formOf(fetch, 1);
    expect(second.get('From')).toBe(TWILIO_NUMBER);
    expect(second.has('CallToken')).toBe(false);
    expect(complete).not.toHaveBeenCalled();
  });

  it.each([
    [400, 21211],
    [403, 21210],
    [429, 20429],
    [500, 21210],
    [403, 21212],
    [500, 21212],
  ])('does not retry status %s code %s', async (status, code) => {
    const ctx = setupTransfer({ callToken: CALL_TOKEN });
    ctx.fetch.mockImplementationOnce(responds(JSON.stringify({ code }), { status }));
    await ctx.enter();
    expect(ctx.fetch).toHaveBeenCalledOnce();
    expectDialFailure(ctx, `Twilio call creation failed (${status}, code ${code})`);
  });

  it('does not retry an ambiguous network timeout', async () => {
    const ctx = setupTransfer({ callToken: CALL_TOKEN });
    ctx.fetch.mockRejectedValueOnce(new Error('request timed out'));
    await ctx.enter();
    expect(ctx.fetch).toHaveBeenCalledOnce();
    expectDialFailure(ctx, 'request timed out');
  });

  it.each([undefined, ''])(
    'does not retry business caller rejection with token %s',
    async (callToken) => {
      const { fetch, enter } = setupTransfer({ callToken });
      fetch.mockImplementationOnce(responds('{"code":21210}', { status: 400 }));
      await enter();
      expect(fetch).toHaveBeenCalledOnce();
      const form = formOf(fetch, 0);
      expect(form.get('From')).toBe(TWILIO_NUMBER);
      expect(form.has('CallToken')).toBe(false);
    },
  );

  it('cancels an unanswered fallback call by its own SID', async () => {
    const { fetch, enter } = setupTransfer({
      callToken: CALL_TOKEN,
      answered: false,
      ringingTimeout: 10,
    });
    fetch.mockImplementationOnce(responds('{"code":21210}', { status: 400 }));
    fetch.mockImplementationOnce(responds('{"sid":"CA_fallback"}'));
    await enter();
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls[2]![0]).toContain('/Calls/CA_fallback.json');
    expect(
      Object.fromEntries(new URLSearchParams(fetch.mock.calls[2]![1].body.toString())),
    ).toEqual({ Status: 'canceled' });
  });

  it('requires original caller when a token is supplied', () => {
    expect(() =>
      createTwilioConnectorWarmTransferTask({
        phoneNumber: HUMAN_NUMBER,
        twilioFromNumber: TWILIO_NUMBER,
        twilioAccountSid: 'AC_test',
        twilioAuthToken: 'test',
        twilioCallToken: CALL_TOKEN,
      }),
    ).toThrow('twilioCallToken requires originalCallerNumber');
  });
});

describe('Twilio dial cancellation', () => {
  it('places no call when the transfer aborts while the connector session opens', async () => {
    const controller = new AbortController();
    const { fetch, connect, complete, enter } = setupTransfer({
      callToken: CALL_TOKEN,
      answered: false,
      abortSignal: controller.signal,
    });
    connect.mockImplementation(async () => {
      // Abort mid-flight, then yield so the task's cancellation path runs
      // before the connector session resolves.
      controller.abort(new Error('transfer deadline reached'));
      await new Promise((resolve) => setTimeout(resolve, 0));
      return new ConnectTwilioCallResponse({ connectUrl: CONNECT_URL });
    });

    await enter();

    // The outer workflow can finish before the connector hook. Drain its timer
    // and promise continuations before asserting that it did not dial late.
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(connect).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'transfer deadline reached' }),
    );
  });

  it.each([false, true])(
    'cancels a late-created call after abort; fallback=%s',
    async (fallback) => {
      const controller = new AbortController();
      const { fetch, enter } = setupTransfer({
        callToken: CALL_TOKEN,
        answered: false,
        abortSignal: controller.signal,
      });
      if (fallback) {
        fetch.mockImplementationOnce(responds('{"code":21210}', { status: 400 }));
      }
      fetch.mockImplementationOnce(() => {
        controller.abort();
        return Promise.resolve(new Response('{"sid":"CA_aborted"}'));
      });

      await enter();
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(fallback ? 3 : 2));
      const cancelIndex = fallback ? 2 : 1;
      expect(fetch.mock.calls[cancelIndex]![0]).toContain('/Calls/CA_aborted.json');
      expect(
        Object.fromEntries(new URLSearchParams(fetch.mock.calls[cancelIndex]![1].body.toString())),
      ).toEqual({ Status: 'canceled' });
    },
  );

  it('does not start a fallback after cancellation', async () => {
    const controller = new AbortController();
    const { fetch, enter } = setupTransfer({
      callToken: CALL_TOKEN,
      abortSignal: controller.signal,
    });
    fetch.mockImplementationOnce(async () => {
      controller.abort();
      return new Response('{"code":21210}', { status: 400 });
    });
    await enter();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fetch).toHaveBeenCalledOnce();
  });
});
