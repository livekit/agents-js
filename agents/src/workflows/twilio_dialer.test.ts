// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { ConnectTwilioCallResponse } from '@livekit/protocol';
import {
  type RemoteParticipant,
  type RemoteTrackPublication,
  Room,
  RoomEvent,
  TrackKind,
} from '@livekit/rtc-node';
import { ConnectorClient } from 'livekit-server-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { log } from '../log.js';
import { Future } from '../utils.js';
import type { TwilioConnectorWarmTransferTaskOptions } from './twilio_connector_warm_transfer.js';
import { createTwilioRecipientDialer } from './twilio_dialer.js';

const options: TwilioConnectorWarmTransferTaskOptions = {
  phoneNumber: '+15555550103',
  twilioFromNumber: '+15555550102',
  twilioAccountSid: 'AC_test',
  twilioAuthToken: 'test-auth',
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function setup(ringingTimeout: number | null = 5_000) {
  const room = new Room();
  const signal = new AbortController();
  const connector = vi
    .spyOn(ConnectorClient.prototype, 'connectTwilioCall')
    .mockResolvedValue(
      new ConnectTwilioCallResponse({ connectUrl: 'wss://connector.example/stream' }),
    );
  const fetch = vi
    .fn()
    .mockImplementation(() => Promise.resolve(new Response('{"sid":"CA_test"}')));
  vi.stubGlobal('fetch', fetch);
  const dial = createTwilioRecipientDialer({ ...options, ringingTimeout });
  const start = () =>
    dial({
      roomName: 'consult-room',
      recipientIdentity: 'recipient',
      room,
      connection: { url: 'wss://example.livekit.cloud', apiKey: 'key', apiSecret: 'secret' },
      signal: signal.signal,
    });
  const publish = (identity = 'recipient', kind = TrackKind.KIND_AUDIO) => {
    const pub = { kind } as RemoteTrackPublication;
    const participant = {
      identity,
      trackPublications: new Map([['track', pub]]),
    } as RemoteParticipant;
    room.remoteParticipants.set(identity, participant);
    room.emit(RoomEvent.TrackPublished, pub, participant);
  };
  return { room, signal, connector, fetch, start, publish };
}

describe('Twilio recipient dialer', () => {
  it('waits for recipient audio, removes its listeners, and hands off the call', async () => {
    const ctx = setup();
    const done = vi.fn();
    const outcome = ctx.start().then(done);
    await vi.waitFor(() => expect(ctx.room.listenerCount(RoomEvent.TrackPublished)).toBe(1));
    ctx.publish('other');
    ctx.publish('recipient', TrackKind.KIND_VIDEO);
    await Promise.resolve();
    expect(done).not.toHaveBeenCalled();
    ctx.publish();
    await outcome;
    ctx.signal.abort();
    expect(ctx.fetch).toHaveBeenCalledOnce();
    expect(ctx.room.listenerCount(RoomEvent.TrackPublished)).toBe(0);
    expect(ctx.room.listenerCount(RoomEvent.ParticipantConnected)).toBe(0);
  });

  it('ends an answered call when cancellation wins in the same turn', async () => {
    const ctx = setup();
    const reason = new Error('cancelled');
    const outcome = ctx.start().catch((error) => error);
    await vi.waitFor(() => expect(ctx.room.listenerCount(RoomEvent.TrackPublished)).toBe(1));
    ctx.publish();
    ctx.signal.abort(reason);
    expect(await outcome).toBe(reason);
    expect(ctx.fetch).toHaveBeenCalledTimes(2);
    expect(Object.fromEntries(ctx.fetch.mock.calls[1]![1].body)).toEqual({ Status: 'completed' });
    expect(ctx.room.listenerCount(RoomEvent.TrackPublished)).toBe(0);
  });

  it('returns a ringing timeout while cleanup is pending and bounds the cleanup request', async () => {
    const ctx = setup(10);
    const cleanup = new AbortController();
    const originalTimeout = AbortSignal.timeout;
    const timeout = vi
      .spyOn(AbortSignal, 'timeout')
      .mockImplementation((ms) => (ms === 10_000 ? cleanup.signal : originalTimeout(ms)));
    const warning = vi.spyOn(log(), 'warn');
    ctx.fetch
      .mockImplementationOnce(() => Promise.resolve(new Response('{"sid":"CA_test"}')))
      .mockImplementationOnce(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal!.addEventListener('abort', () => reject(init.signal!.reason), {
              once: true,
            });
          }),
      );
    try {
      await expect(ctx.start()).rejects.toThrow('recipient did not answer');
      expect(ctx.fetch).toHaveBeenCalledTimes(2);
      expect(timeout).toHaveBeenCalledWith(10_000);
      expect(ctx.fetch.mock.calls[1]![1].signal).toBe(cleanup.signal);
      expect(warning).not.toHaveBeenCalled();
    } finally {
      cleanup.abort();
    }
    await vi.waitFor(() => expect(warning).toHaveBeenCalledOnce());
  });

  it('does not start connector setup after cancellation', async () => {
    const ctx = setup();
    ctx.signal.abort();
    await expect(ctx.start()).rejects.toThrow();
    expect(ctx.connector).not.toHaveBeenCalled();
    expect(ctx.fetch).not.toHaveBeenCalled();
  });

  it.each(['throw', 'reject'] as const)(
    'propagates a connector %s without dialing',
    async (mode) => {
      const ctx = setup();
      const error = new Error('connector unavailable');
      ctx.connector.mockImplementation(() => {
        if (mode === 'throw') throw error;
        return Promise.reject(error);
      });
      await expect(ctx.start()).rejects.toBe(error);
      expect(ctx.fetch).not.toHaveBeenCalled();
    },
  );

  it('keeps ownership of a pending creation response after cancellation', async () => {
    const ctx = setup();
    const response = new Future<Response>();
    ctx.fetch.mockReturnValueOnce(response.await);
    const reason = new Error('cancelled');
    const outcome = ctx.start().catch((error) => error);
    await vi.waitFor(() => expect(ctx.fetch).toHaveBeenCalledOnce());
    // Do not abort the creation request: its SID is needed to end a late call.
    expect(ctx.fetch.mock.calls[0]![1].signal).toBeUndefined();
    ctx.signal.abort(reason);
    response.resolve(new Response('{"sid":"CA_late"}'));
    expect(await outcome).toBe(reason);
    expect(ctx.fetch.mock.calls[1]![0]).toContain('/Calls/CA_late.json');
  });

  it.each([-1, 1.5, NaN, Infinity, 2_147_483_648])(
    'rejects invalid ringing timeout %s eagerly',
    (ringingTimeout) => {
      expect(() => createTwilioRecipientDialer({ ...options, ringingTimeout })).toThrow(
        'ringingTimeout',
      );
    },
  );

  it('validates credentials before running the workflow', () => {
    vi.stubEnv('TWILIO_ACCOUNT_SID', '');
    vi.stubEnv('TWILIO_AUTH_TOKEN', '');
    expect(() =>
      createTwilioRecipientDialer({
        phoneNumber: options.phoneNumber,
        twilioFromNumber: options.twilioFromNumber,
      }),
    ).toThrow('Twilio credentials are required');
  });
});
