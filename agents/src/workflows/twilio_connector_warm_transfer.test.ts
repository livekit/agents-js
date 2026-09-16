// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { ConnectTwilioCallResponse } from '@livekit/protocol';
import { ParticipantKind, type RemoteParticipant, Room, TrackKind } from '@livekit/rtc-node';
import { AccessToken, ConnectorClient } from 'livekit-server-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as job from '../job.js';
import type { JobContext } from '../job.js';
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

function setupTransfer(callToken?: string, answered = true) {
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
  const connect = vi
    .spyOn(ConnectorClient.prototype, 'connectTwilioCall')
    .mockResolvedValue(new ConnectTwilioCallResponse({ connectUrl: CONNECT_URL }));
  const fetch = vi
    .fn()
    .mockResolvedValue(new Response(JSON.stringify({ sid: 'CA_test_transfer' })));
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
    twilioFromNumber: callToken === undefined ? TWILIO_NUMBER : CALLER_NUMBER,
    twilioCallToken: callToken,
    twilioAccountSid: 'AC_test_account',
    twilioAuthToken: 'test_auth_token',
    ringingTimeout: 10,
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
  return { task, connect, fetch, complete, enter };
}

describe('Twilio connector CallToken forwarding', () => {
  it.each([undefined, CALL_TOKEN])('preserves caller ID with token %s', async (callToken) => {
    const { task, connect, fetch, complete, enter } = setupTransfer(callToken);

    await enter();

    expect(complete).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledOnce();
    const [url, request] = fetch.mock.calls[0]!;
    expect(url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC_test_account/Calls.json');
    expect(request.method).toBe('POST');
    const form = new URLSearchParams(request.body.toString());
    expect(form.get('To')).toBe(HUMAN_NUMBER);
    expect(form.get('From')).toBe(callToken === undefined ? TWILIO_NUMBER : CALLER_NUMBER);
    expect(form.get('CallToken')).toBe(callToken ?? null);
    expect(form.get('Twiml')).toContain('one=1&amp;two=2');
    expect(form.get('Twiml')).not.toContain(CALL_TOKEN);
    expect(JSON.stringify(connect.mock.calls)).not.toContain(CALL_TOKEN);
    expect(task.instructions).not.toContain(CALL_TOKEN);
    expect(JSON.stringify(task.chatCtx.toJSON())).not.toContain(CALL_TOKEN);
  });

  it('does not retry a rejected token with another caller ID', async () => {
    const { fetch, complete, enter } = setupTransfer(CALL_TOKEN);
    fetch.mockResolvedValue(new Response('{"message":"Invalid CallToken"}', { status: 403 }));

    await enter();

    expect(fetch).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledWith(expect.any(Error));
  });

  it('cancels an unanswered forwarded call without reusing the token in the cancellation', async () => {
    const { fetch, complete, enter } = setupTransfer(CALL_TOKEN, false);

    await enter();

    expect(fetch).toHaveBeenCalledTimes(2);
    const [url, request] = fetch.mock.calls[1]!;
    expect(url).toBe(
      'https://api.twilio.com/2010-04-01/Accounts/AC_test_account/Calls/CA_test_transfer.json',
    );
    expect(Object.fromEntries(new URLSearchParams(request.body.toString()))).toEqual({
      Status: 'canceled',
    });
    expect(complete).toHaveBeenCalledWith(expect.any(Error));
  });
});
