// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { APITimeoutError } from './_exceptions.js';
import { DEFAULT_API_CONNECT_OPTIONS } from './types.js';
import { WebSocketMonitor } from './websocket_monitor.js';

interface SocketPair {
  client: WebSocket;
  peer: WebSocket;
  server: WebSocketServer;
}

async function socketPair(options: { serverAutoPong?: boolean } = {}): Promise<SocketPair> {
  const server = new WebSocketServer({
    host: '127.0.0.1',
    port: 0,
    autoPong: options.serverAutoPong,
  });
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  const peerConnected = once(server, 'connection');
  const client = new WebSocket(`ws://127.0.0.1:${port}`);
  const [[peer]] = await Promise.all([peerConnected, once(client, 'open')]);
  return { client, peer: peer as WebSocket, server };
}

async function closePair({ client, server }: SocketPair): Promise<void> {
  if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
    client.terminate();
  }
  for (const socket of server.clients) socket.terminate();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function nextError(ws: WebSocket): Promise<Error> {
  return once(ws, 'error').then(([error]) => error as Error);
}

describe('WebSocketMonitor', () => {
  const pairs: SocketPair[] = [];

  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(pairs.splice(0).map(closePair));
  });

  it.each([
    ['default', undefined, DEFAULT_API_CONNECT_OPTIONS.livenessTimeoutMs],
    ['custom', 300, 300],
  ] as const)(
    'uses %s liveness timing for its probe and failure',
    async (_, configured, timeout) => {
      const pair = await socketPair({ serverAutoPong: false });
      pairs.push(pair);
      vi.useFakeTimers();
      const ping = vi.spyOn(pair.client, 'ping');
      const error = nextError(pair.client);

      new WebSocketMonitor(
        pair.client,
        configured === undefined ? undefined : { livenessTimeoutMs: configured },
      );
      await vi.advanceTimersByTimeAsync(timeout / 3 - 1);
      expect(ping).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(ping).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync((timeout * 2) / 3 - 1);
      expect(pair.client.readyState).toBe(WebSocket.OPEN);
      await vi.advanceTimersByTimeAsync(1);

      await expect(error).resolves.toMatchObject({
        name: 'APITimeoutError',
        retryable: true,
      });
      expect(pair.client.readyState).not.toBe(WebSocket.OPEN);
    },
  );

  it('keeps silent connections healthy when the peer answers pings', async () => {
    const pair = await socketPair({ serverAutoPong: false });
    pairs.push(pair);
    let pings = 0;
    pair.peer.on('ping', (data) => {
      pings += 1;
      pair.peer.pong(data);
      if (pings === 5) pair.peer.send('still connected');
    });
    const message = once(pair.client, 'message');

    new WebSocketMonitor(pair.client, { livenessTimeoutMs: 600 });

    await expect(message).resolves.toMatchObject([expect.anything(), false]);
    expect(pings).toBe(5);
    expect(pair.client.readyState).toBe(WebSocket.OPEN);
  });

  it.each(['text', 'binary', 'ping', 'pong'] as const)(
    'resets the deadline on inbound %s frames without sending client pings',
    async (messageType) => {
      const pair = await socketPair();
      pairs.push(pair);
      let clientPings = 0;
      let clientPongs = 0;
      pair.peer.on('ping', () => {
        clientPings += 1;
      });
      pair.peer.on('pong', () => {
        clientPongs += 1;
      });
      const done = new Promise<void>((resolve) => {
        pair.client.on('message', (data) => {
          if (data.toString() === 'done') resolve();
        });
      });
      new WebSocketMonitor(pair.client, { livenessTimeoutMs: 150 });

      for (let index = 0; index < 15; index += 1) {
        await new Promise((resolve) => setTimeout(resolve, 15));
        if (messageType === 'text') pair.peer.send('activity');
        if (messageType === 'binary') pair.peer.send(Buffer.from('activity'));
        if (messageType === 'ping') pair.peer.ping('activity');
        if (messageType === 'pong') pair.peer.pong('activity');
      }
      pair.peer.send('done');
      await done;

      expect(clientPings).toBe(0);
      if (messageType === 'ping') {
        await vi.waitFor(() => expect(clientPongs).toBe(15));
      }
    },
  );

  it('does not let outbound traffic hide an unanswered ping', async () => {
    const pair = await socketPair({ serverAutoPong: false });
    pairs.push(pair);
    let pings = 0;
    let audioFrames = 0;
    pair.peer.on('ping', () => {
      pings += 1;
    });
    pair.peer.on('message', () => {
      audioFrames += 1;
    });
    const sender = setInterval(() => pair.client.send('audio'), 10);
    const error = nextError(pair.client);

    new WebSocketMonitor(pair.client, { livenessTimeoutMs: 180 });
    const result = await error;
    clearInterval(sender);

    expect(result).toBeInstanceOf(APITimeoutError);
    expect(result).toMatchObject({ retryable: true });
    expect(pair.client.readyState).not.toBe(WebSocket.OPEN);
    expect(pings).toBe(1);
    expect(audioFrames).toBeGreaterThan(1);
  });

  it('resets a pending failure when data arrives after a ping', async () => {
    const pair = await socketPair({ serverAutoPong: false });
    pairs.push(pair);
    let pings = 0;
    pair.peer.on('ping', () => {
      pings += 1;
    });
    const messages: string[] = [];
    pair.client.on('message', (data) => messages.push(data.toString()));
    const error = nextError(pair.client);

    new WebSocketMonitor(pair.client, { livenessTimeoutMs: 180 });
    await new Promise((resolve) => setTimeout(resolve, 110));
    pair.peer.send('first');
    await new Promise((resolve) => setTimeout(resolve, 110));
    pair.peer.send('second');

    await vi.waitFor(() => expect(messages).toEqual(['first', 'second']));
    await expect(error).resolves.toBeInstanceOf(APITimeoutError);
    expect(pings).toBeGreaterThanOrEqual(2);
  });

  it('terminates within the liveness bound when the peer cannot complete a close handshake', async () => {
    const pair = await socketPair({ serverAutoPong: false });
    pairs.push(pair);
    const started = performance.now();
    const error = nextError(pair.client);

    new WebSocketMonitor(pair.client, { livenessTimeoutMs: 120 });

    await expect(error).resolves.toBeInstanceOf(APITimeoutError);
    expect(performance.now() - started).toBeLessThan(500);
    expect(pair.client.readyState).not.toBe(WebSocket.OPEN);
  });
});
