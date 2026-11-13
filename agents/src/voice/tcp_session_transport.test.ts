// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AgentSession as pb } from '@livekit/protocol';
import type { Throws } from '@livekit/throws-transformer/throws';
import * as net from 'node:net';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { initializeLogger } from '../log.js';
import { Future } from '../utils.js';
import { TcpSessionTransport } from './remote_session.js';
import { pingMessage, request } from './testing/remote_session.js';

beforeAll(() => initializeLogger({ pretty: false, level: 'warn' }));
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});

async function listen(server: net.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as net.AddressInfo).port;
}

function frame(msg: pb.AgentSessionMessage): Buffer {
  const data = msg.toBinary();
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(data.length, 0);
  return Buffer.concat([header, Buffer.from(data)]);
}

describe('TcpSessionTransport framing', () => {
  let server: net.Server | undefined;
  let transport: TcpSessionTransport | undefined;

  afterEach(async () => {
    await transport?.close();
    transport = undefined;
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
  });

  it('decodes a single framed message', async () => {
    server = net.createServer((sock) => {
      sock.write(frame(pingMessage('r1')));
    });
    const port = await listen(server);

    transport = new TcpSessionTransport('127.0.0.1', port);
    await transport.start();

    const it = transport[Symbol.asyncIterator]();
    const { value, done } = await it.next();
    expect(done).toBe(false);
    expect(value.message.case).toBe('request');
    expect((value.message.value as pb.SessionRequest).requestId).toBe('r1');
  });

  it('reassembles a frame delivered across multiple chunks', async () => {
    const buf = frame(pingMessage('split'));
    server = net.createServer((sock) => {
      // header + 1 byte, then the remainder after a tick
      sock.write(buf.subarray(0, 5));
      setTimeout(() => sock.write(buf.subarray(5)), 10);
    });
    const port = await listen(server);

    transport = new TcpSessionTransport('127.0.0.1', port);
    await transport.start();

    const it = transport[Symbol.asyncIterator]();
    const { value } = await it.next();
    expect((value.message.value as pb.SessionRequest).requestId).toBe('split');
  });

  it('decodes multiple frames coalesced into one chunk', async () => {
    server = net.createServer((sock) => {
      sock.write(Buffer.concat([frame(pingMessage('a')), frame(pingMessage('b'))]));
    });
    const port = await listen(server);

    transport = new TcpSessionTransport('127.0.0.1', port);
    await transport.start();

    const it = transport[Symbol.asyncIterator]();
    const first = await it.next();
    const second = await it.next();
    expect((first.value.message.value as pb.SessionRequest).requestId).toBe('a');
    expect((second.value.message.value as pb.SessionRequest).requestId).toBe('b');
  });

  it('round-trips a sent message back through the wire', async () => {
    const received: Buffer[] = [];
    const sawFullFrame = new Promise<void>((resolve) => {
      server = net.createServer((sock) => {
        sock.on('data', (d) => {
          received.push(d);
          resolve();
        });
      });
    });
    const port = await listen(server!);

    transport = new TcpSessionTransport('127.0.0.1', port);
    await transport.start();
    await transport.sendMessage(pingMessage('outbound'));

    await sawFullFrame;
    const wire = Buffer.concat(received);
    const length = wire.readUInt32BE(0);
    const decoded = pb.AgentSessionMessage.fromBinary(wire.subarray(4, 4 + length));
    expect((decoded.message.value as pb.SessionRequest).requestId).toBe('outbound');
  });

  it('rejects start() when nothing is listening', async () => {
    // ephemeral port that is (almost certainly) closed
    const t = new TcpSessionTransport('127.0.0.1', 1);
    await expect(t.start()).rejects.toThrow();
  });

  it('rejects a backpressured sendMessage when the transport closes', async () => {
    // Self-contained: a non-reading server leaves its connection open, so we
    // manage its lifecycle here rather than via the shared afterEach.
    let serverSocket: net.Socket | undefined;
    const localServer = net.createServer((sock) => {
      serverSocket = sock; // intentionally never consume incoming data
    });
    const port = await listen(localServer);

    const t = new TcpSessionTransport('127.0.0.1', port);
    await t.start();
    try {
      // Fill the socket buffer so the write callback must wait for the peer.
      const huge = 'x'.repeat(4 * 1024 * 1024);
      const msg = new pb.AgentSessionMessage({
        message: {
          case: 'request',
          value: new pb.SessionRequest({
            requestId: huge,
            request: { case: 'ping', value: new pb.SessionRequest_Ping() },
          }),
        },
      });

      const sendPromise = t.sendMessage(msg);
      const rejected = expect(sendPromise).rejects.toThrow();
      await new Promise((r) => setTimeout(r, 50)); // ensure we're parked in the drain wait
      await t.close();

      // Without the close/error race this would hang until the test times out.
      await rejected;
    } finally {
      await t.close();
      serverSocket?.destroy();
      await new Promise<void>((resolve) => localServer.close(() => resolve()));
    }
  });
});

describe('SessionTransport failures surface to the caller', () => {
  it('tcp transport rejects once closed', async () => {
    const server = net.createServer(() => {});
    const port = await listen(server);
    const t = new TcpSessionTransport('127.0.0.1', port);
    try {
      await t.start();
      await t.close();
      await expect(t.sendMessage(pingMessage('r2'))).rejects.toThrow(
        /tcp session transport is closed/,
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('TCP send failure', () => {
  async function connection() {
    const connected = new Future<net.Socket>();
    const server = net.createServer((socket) => {
      socket.pause();
      connected.resolve(socket);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const transport = new TcpSessionTransport(
      '127.0.0.1',
      (server.address() as net.AddressInfo).port,
    );
    await transport.start();
    const peer = await connected.await;
    cleanup.push(async (): Promise<Throws<void, Error>> => {
      await transport.close();
      peer.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    return { transport, peer, socket: (transport as unknown as { socket: net.Socket }).socket };
  }
  it('rejects writes after peer disconnect', async (): Promise<Throws<void, Error>> => {
    const { transport, peer } = await connection();
    const reader = (async () => {
      for await (const _msg of transport) {
        /* consume */
      }
    })();
    peer.destroy();
    await reader;
    await expect(
      transport.sendMessage(request('lost', { case: 'ping', value: new pb.SessionRequest_Ping() })),
    ).rejects.toThrow();
  });
  it('closes the socket on an oversized frame', async () => {
    const { transport, peer, socket } = await connection();
    const next = transport[Symbol.asyncIterator]().next();
    const header = Buffer.alloc(4);
    header.writeUInt32BE((1 << 20) + 1);
    peer.write(header);
    expect((await next).done).toBe(true);
    expect(socket.destroyed).toBe(true);
    await expect(transport.sendMessage(new pb.AgentSessionMessage())).rejects.toThrow();
  });

  it('keeps accepted TCP responses writable after intake aborts', async (): Promise<
    Throws<void, Error>
  > => {
    const { transport, peer, socket } = await connection();
    const controller = new AbortController();
    const next = transport[Symbol.asyncIterator](controller.signal).next();
    controller.abort();
    expect((await next).done).toBe(true);
    const received = new Future<Buffer>();
    peer.once('data', (data) => received.resolve(data));
    peer.resume();
    const msg = request('accepted', { case: 'ping', value: new pb.SessionRequest_Ping() });
    await transport.sendMessage(msg);
    expect((await received.await).subarray(4)).toEqual(Buffer.from(msg.toBinary()));
    expect(socket.destroyed).toBe(false);
  });
  it('rejects a backpressured valid-size frame when a real peer resets', async (): Promise<
    Throws<void, Error>
  > => {
    const { transport, peer, socket } = await connection();
    socket.on('error', () => {});
    const msg = request('x'.repeat(512 * 1024), {
      case: 'ping',
      value: new pb.SessionRequest_Ping(),
    });
    expect(msg.toBinary().length).toBeLessThan(1 << 20);
    let stopped = false;
    const sending = (async () => {
      for (let n = 0; !stopped && n < 64; n++) await transport.sendMessage(msg);
    })();
    const rejected = expect(sending).rejects.toThrow();
    await vi.waitFor(() => expect(socket.writableLength).toBeGreaterThan(65536));
    stopped = true;
    peer.resetAndDestroy();
    await rejected;
  });
  it.each(['error', 'close'] as const)(
    'rejects a pending write on socket %s and removes its listeners',
    async (failure) => {
      const { transport, socket } = await connection();
      const errorListeners = socket.listenerCount('error');
      const closeListeners = socket.listenerCount('close');
      const writing = new Future<void>();
      vi.spyOn(socket, 'write').mockImplementation(() => {
        writing.resolve();
        return false;
      });
      const result = transport.sendMessage(
        request('pending', { case: 'ping', value: new pb.SessionRequest_Ping() }),
      );
      const rejected = expect(result).rejects.toThrow();
      await writing.await;
      if (failure === 'error') socket.emit('error', new Error('write failed'));
      else socket.emit('close');
      await rejected;
      expect(socket.listenerCount('error')).toBe(errorListeners);
      expect(socket.listenerCount('close')).toBe(closeListeners);
    },
  );

  it('serializes writes and drops a cancelled lock waiter', async () => {
    const { transport, socket } = await connection();
    const callbacks: ((error?: Error) => void)[] = [];
    const writes = vi.spyOn(socket, 'write').mockImplementation(((
      _data: unknown,
      callback: (error?: Error) => void,
    ) => {
      callbacks.push(callback);
      return true;
    }) as typeof socket.write);
    const msg = request('queued', { case: 'ping', value: new pb.SessionRequest_Ping() });
    const first = transport.sendMessage(msg);
    await tick();
    const controller = new AbortController();
    const cancelled = transport.sendMessage(msg, controller.signal).catch((error) => error);
    const third = transport.sendMessage(msg);
    controller.abort();
    expect(await cancelled).toBeInstanceOf(Error);
    expect(writes).toHaveBeenCalledTimes(1);
    callbacks[0]!();
    await first;
    await tick();
    expect(writes).toHaveBeenCalledTimes(2);
    callbacks[1]!();
    await third;
  });

  it('rejects asynchronous write callback errors even without backpressure', async () => {
    const { transport, socket } = await connection();
    vi.spyOn(socket, 'write').mockImplementation(((
      _data: unknown,
      callback: (error?: Error) => void,
    ) => {
      queueMicrotask(() => callback?.(new Error('write callback failed')));
      return true;
    }) as typeof socket.write);
    await expect(
      transport.sendMessage(request('lost', { case: 'ping', value: new pb.SessionRequest_Ping() })),
    ).rejects.toThrow('write callback failed');
  });
});
