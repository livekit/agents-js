// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { SIPParticipantInfo } from '@livekit/protocol';
import { Room } from '@livekit/rtc-node';
import { RoomServiceClient, SipClient } from 'livekit-server-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Future } from '../utils.js';
import { createSipRecipientDialer } from './sip_dialer.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function setup() {
  const response = new Future<SIPParticipantInfo>();
  vi.spyOn(SipClient.prototype, 'createSipParticipant').mockReturnValue(response.await);
  const controller = new AbortController();
  const participant = new SIPParticipantInfo({
    roomName: 'consult-room',
    participantIdentity: 'recipient',
  });
  const dial = createSipRecipientDialer({ sipCallTo: '+15551234567', sipTrunkId: 'ST_test' });
  const start = () =>
    dial({
      roomName: 'consult-room',
      recipientIdentity: 'recipient',
      room: new Room(),
      connection: {
        url: 'wss://example.livekit.cloud',
        apiKey: 'api-key',
        apiSecret: 'api-secret',
      },
      signal: controller.signal,
    });
  return { response, controller, participant, start };
}

describe('SIP dial cancellation', () => {
  it('cleans up when answer and cancellation arrive in the same turn', async () => {
    const ctx = setup();
    const remove = vi.spyOn(RoomServiceClient.prototype, 'removeParticipant').mockResolvedValue();
    const reason = new Error('cancelled');
    const outcome = ctx.start().catch((error) => error);
    ctx.response.resolve(ctx.participant);
    ctx.controller.abort(reason);
    expect(await outcome).toBe(reason);
    expect(remove).toHaveBeenCalledExactlyOnceWith('consult-room', 'recipient');
  });

  it('leaves an answered call owned by the workflow', async () => {
    const ctx = setup();
    const remove = vi.spyOn(RoomServiceClient.prototype, 'removeParticipant').mockResolvedValue();
    const outcome = ctx.start();
    ctx.response.resolve(ctx.participant);
    await outcome;
    ctx.controller.abort();
    expect(remove).not.toHaveBeenCalled();
  });

  it('bounds cleanup and preserves the cancellation reason when cleanup times out', async () => {
    const ctx = setup();
    const timeout = new AbortController();
    const deadline = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal);
    const fetch = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
        }),
    );
    vi.stubGlobal('fetch', fetch);
    const reason = new Error('cancelled');
    const outcome = ctx.start().catch((error) => error);
    ctx.controller.abort(reason);
    ctx.response.resolve(ctx.participant);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    expect(deadline).toHaveBeenCalledWith(10_000);
    expect(fetch.mock.calls[0]![1].signal).toBe(timeout.signal);
    timeout.abort(new Error('cleanup timed out'));
    expect(await outcome).toBe(reason);
  });
});
