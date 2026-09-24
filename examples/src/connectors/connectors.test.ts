// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { ConnectorClient } from 'livekit-server-sdk';
import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function startWhatsApp() {
  vi.stubEnv('LIVEKIT_URL', 'wss://example.livekit.cloud');
  vi.spyOn(process, 'argv', 'get').mockReturnValue([
    'node',
    'whatsapp_connector.ts',
    'serve',
    '--allow-unverified',
  ]);
  vi.spyOn(process, 'once').mockReturnValue(process);
  let handler!: http.RequestListener;
  const server = { listen: vi.fn(), close: vi.fn() };
  vi.spyOn(http, 'createServer').mockImplementation(((callback: http.RequestListener) => {
    handler = callback;
    return server as unknown as http.Server;
  }) as typeof http.createServer);
  await import('./whatsapp_connector.js');
  const post = async (id: string, event: string, direction = 'USER_INITIATED') => {
    const body = {
      entry: [
        {
          changes: [
            {
              field: 'calls',
              value: {
                metadata: { phone_number_id: 'number-id' },
                calls: [{ id, event, direction, session: { sdp_type: 'offer', sdp: 'test-sdp' } }],
              },
            },
          ],
        },
      ],
    };
    const request = {
      method: 'POST',
      url: '/whatsapp/webhook',
      headers: {},
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(JSON.stringify(body));
      },
    };
    const response = { writeHead: vi.fn().mockReturnThis(), end: vi.fn() };
    handler(request as unknown as http.IncomingMessage, response as unknown as http.ServerResponse);
    await vi.waitFor(() => expect(response.end).toHaveBeenCalled());
    expect(response.writeHead).toHaveBeenCalledWith(200);
  };
  return { post };
}

describe('connector examples', () => {
  it.each(['USER_INITIATED', 'BUSINESS_INITIATED'])(
    'orders termination after pending connection: %s',
    async (direction) => {
      const pending = deferred<never>();
      const accept = vi
        .spyOn(ConnectorClient.prototype, 'acceptWhatsAppCall')
        .mockReturnValue(pending.promise);
      const connect = vi
        .spyOn(ConnectorClient.prototype, 'connectWhatsAppCall')
        .mockReturnValue(pending.promise);
      const disconnect = vi
        .spyOn(ConnectorClient.prototype, 'disconnectWhatsAppCall')
        .mockResolvedValue({} as never);
      const { post } = await startWhatsApp();
      try {
        await post('call-1', 'connect', direction);
        expect(direction === 'USER_INITIATED' ? accept : connect).toHaveBeenCalledOnce();
        await post('call-1', 'terminate', direction);
        expect(disconnect).not.toHaveBeenCalled();
        pending.resolve({ roomName: 'call-room' } as never);
        await vi.waitFor(() => expect(disconnect).toHaveBeenCalledOnce());
        expect(disconnect.mock.calls[0]![0]).toBe('call-1');
      } finally {
        pending.resolve({ roomName: 'call-room' } as never);
      }
    },
  );

  it('handles different WhatsApp calls concurrently', async () => {
    const pending = deferred<never>();
    const accept = vi
      .spyOn(ConnectorClient.prototype, 'acceptWhatsAppCall')
      .mockReturnValue(pending.promise);
    const { post } = await startWhatsApp();
    try {
      await post('call-1', 'connect');
      await post('call-2', 'connect');
      expect(accept).toHaveBeenCalledTimes(2);
    } finally {
      pending.resolve({ roomName: 'call-room' } as never);
    }
  });

  it('isolates outbound Twilio calls started at the same time', async () => {
    vi.stubEnv('LIVEKIT_URL', 'wss://example.livekit.cloud');
    vi.stubEnv('TWILIO_ACCOUNT_SID', 'AC_test');
    vi.stubEnv('TWILIO_AUTH_TOKEN', 'test-token');
    vi.stubEnv('TWILIO_FROM_NUMBER', '+15555550100');
    vi.spyOn(process, 'argv', 'get').mockReturnValue([
      'node',
      'twilio_connector.ts',
      'dial',
      '--to',
      '+15555550101',
    ]);
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const connect = vi
      .spyOn(ConnectorClient.prototype, 'connectTwilioCall')
      .mockResolvedValue({ connectUrl: 'wss://connector.example/stream' } as never);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => new Response('{"sid":"CA_test"}')),
    );
    await import('./twilio_connector.js');
    vi.resetModules();
    await import('./twilio_connector.js');
    expect(connect).toHaveBeenCalledTimes(2);
    expect(connect.mock.calls[0]![0].roomName).not.toBe(connect.mock.calls[1]![0].roomName);
  });
});
