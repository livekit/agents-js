// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AgentSession as pb } from '@livekit/protocol';
import * as net from 'node:net';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { initializeLogger } from '../log.js';
import type { AgentSession } from './agent_session.js';
import { SessionHost, SessionTransport, TcpSessionTransport } from './remote_session.js';

beforeAll(() => {
  initializeLogger({ pretty: true, level: 'info' });
});

function frame(msg: pb.AgentSessionMessage): Buffer {
  const data = msg.toBinary();
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(data.length, 0);
  return Buffer.concat([header, Buffer.from(data)]);
}

function pingMessage(requestId: string): pb.AgentSessionMessage {
  return new pb.AgentSessionMessage({
    message: {
      case: 'request',
      value: new pb.SessionRequest({
        requestId,
        request: { case: 'ping', value: new pb.SessionRequest_Ping() },
      }),
    },
  });
}

async function listen(server: net.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as net.AddressInfo).port;
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

  it('unblocks a backpressured sendMessage when the transport closes', async () => {
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
      // 4 MiB payload guarantees we exceed the 64 KiB drain threshold and park
      // in waitForDrain (the peer never reads, so no natural 'drain').
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
      await new Promise((r) => setTimeout(r, 50)); // ensure we're parked in the drain wait
      await t.close();

      // Without the close/error race this would hang until the test times out.
      await expect(sendPromise).resolves.toBeUndefined();
    } finally {
      await t.close();
      serverSocket?.destroy();
      await new Promise<void>((resolve) => localServer.close(() => resolve()));
    }
  });
});

/** In-memory transport so SessionHost can be driven without a socket. */
class FakeTransport extends SessionTransport {
  readonly sent: pb.AgentSessionMessage[] = [];
  private readonly inbound: pb.AgentSessionMessage[] = [];
  private waitingResolve: ((value: IteratorResult<pb.AgentSessionMessage>) => void) | null = null;
  private closed = false;

  push(msg: pb.AgentSessionMessage): void {
    if (this.waitingResolve) {
      const resolve = this.waitingResolve;
      this.waitingResolve = null;
      resolve({ value: msg, done: false });
    } else {
      this.inbound.push(msg);
    }
  }

  override async sendMessage(msg: pb.AgentSessionMessage): Promise<void> {
    this.sent.push(msg);
  }

  override async close(): Promise<void> {
    this.closed = true;
    if (this.waitingResolve) {
      const resolve = this.waitingResolve;
      this.waitingResolve = null;
      resolve({ value: undefined as unknown as pb.AgentSessionMessage, done: true });
    }
  }

  override [Symbol.asyncIterator](): AsyncIterator<pb.AgentSessionMessage> {
    return {
      next: () => {
        const pending = this.inbound.shift();
        if (pending) return Promise.resolve({ value: pending, done: false });
        if (this.closed) {
          return Promise.resolve({
            value: undefined as unknown as pb.AgentSessionMessage,
            done: true,
          });
        }
        return new Promise((resolve) => {
          this.waitingResolve = resolve;
        });
      },
    };
  }
}

describe('SessionHost updateIo', () => {
  it('toggles input/output enabled flags and acks', async () => {
    const setInputAudio = vi.fn();
    const setOutputAudio = vi.fn();
    const setTranscription = vi.fn();
    const fakeSession = {
      on: () => {},
      off: () => {},
      input: { setAudioEnabled: setInputAudio },
      output: {
        setAudioEnabled: setOutputAudio,
        setTranscriptionEnabled: setTranscription,
      },
    } as unknown as AgentSession;

    const transport = new FakeTransport();
    const host = new SessionHost(transport);
    host.registerSession(fakeSession);
    await host.start();

    transport.push(
      new pb.AgentSessionMessage({
        message: {
          case: 'request',
          value: new pb.SessionRequest({
            requestId: 'io1',
            request: {
              case: 'updateIo',
              value: new pb.SessionRequest_UpdateIO({
                input: new pb.SessionRequest_UpdateIO_Input({ audioEnabled: false }),
                output: new pb.SessionRequest_UpdateIO_Output({
                  audioEnabled: true,
                  transcriptionEnabled: false,
                }),
              }),
            },
          }),
        },
      }),
    );

    // wait for the tracked task to send the response
    await vi.waitFor(() => expect(transport.sent.length).toBe(1));

    expect(setInputAudio).toHaveBeenCalledWith(false);
    expect(setOutputAudio).toHaveBeenCalledWith(true);
    expect(setTranscription).toHaveBeenCalledWith(false);

    const resp = transport.sent[0]!.message.value as pb.SessionResponse;
    expect(resp.requestId).toBe('io1');
    expect(resp.response.case).toBe('updateIo');

    await host.close();
  });

  it('ignores unset optional fields', async () => {
    const setInputAudio = vi.fn();
    const setOutputAudio = vi.fn();
    const setTranscription = vi.fn();
    const fakeSession = {
      on: () => {},
      off: () => {},
      input: { setAudioEnabled: setInputAudio },
      output: {
        setAudioEnabled: setOutputAudio,
        setTranscriptionEnabled: setTranscription,
      },
    } as unknown as AgentSession;

    const transport = new FakeTransport();
    const host = new SessionHost(transport);
    host.registerSession(fakeSession);
    await host.start();

    transport.push(
      new pb.AgentSessionMessage({
        message: {
          case: 'request',
          value: new pb.SessionRequest({
            requestId: 'io2',
            request: {
              case: 'updateIo',
              value: new pb.SessionRequest_UpdateIO({
                output: new pb.SessionRequest_UpdateIO_Output({ transcriptionEnabled: true }),
              }),
            },
          }),
        },
      }),
    );

    await vi.waitFor(() => expect(transport.sent.length).toBe(1));

    expect(setInputAudio).not.toHaveBeenCalled();
    expect(setOutputAudio).not.toHaveBeenCalled();
    expect(setTranscription).toHaveBeenCalledWith(true);

    await host.close();
  });
});
