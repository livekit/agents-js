// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AgentSession as pb } from '@livekit/protocol';
import * as net from 'node:net';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { InferenceExecutor } from '../ipc/inference_executor.js';
import {
  JobContext,
  type JobProcess,
  type RunningJobInfo,
  runWithJobContextAsync,
} from '../job.js';
import { initializeLogger } from '../log.js';
import type { SimulationContext } from '../simulation.js';
import type { AgentSession } from './agent_session.js';
import { FinalizeSimulationError } from './index.js';
import {
  RemoteSession,
  SessionHost,
  SessionTransport,
  TcpSessionTransport,
} from './remote_session.js';

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
  private peer?: FakeTransport;

  connect(peer: FakeTransport): void {
    this.peer = peer;
  }

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
    this.peer?.push(msg);
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

function createConnectedTransportPair(): [FakeTransport, FakeTransport] {
  const client = new FakeTransport();
  const host = new FakeTransport();
  client.connect(host);
  host.connect(client);
  return [client, host];
}

describe('RemoteSession RPCs', () => {
  it('fetches framework info', async () => {
    const transport = new FakeTransport();
    const remote = new RemoteSession(transport);
    await remote.start();

    const frameworkInfo = remote.fetchFrameworkInfo();
    await vi.waitFor(() => expect(transport.sent.length).toBe(1));

    const request = transport.sent[0]!.message.value as pb.SessionRequest;
    expect(request.request.case).toBe('getFrameworkInfo');

    transport.push(
      new pb.AgentSessionMessage({
        message: {
          case: 'response',
          value: new pb.SessionResponse({
            requestId: request.requestId,
            response: {
              case: 'getFrameworkInfo',
              value: new pb.SessionResponse_GetFrameworkInfoResponse({
                sdk: 'js',
                sdkVersion: '1.5.5',
              }),
            },
          }),
        },
      }),
    );

    await expect(frameworkInfo).resolves.toMatchObject({
      sdk: 'js',
      sdkVersion: '1.5.5',
    });
    await remote.close();
  });
});

async function startConnectedClientHost(ctx: JobContext) {
  const [clientTransport, hostTransport] = createConnectedTransportPair();
  const remote = new RemoteSession(clientTransport);
  const host = new SessionHost(hostTransport);
  host.registerSession(fakeAgentSession());
  await runWithJobContextAsync(ctx, async () => host.start());
  await remote.start();

  return { remote, host, clientTransport, hostTransport };
}

describe('RemoteSession and SessionHost finalizeSimulation', () => {
  it('round-trips a normal finalize through connected transports', async () => {
    const ctx = fakeSimJobContext((simCtx) => {
      expect(simCtx.simulatorVerdict).toEqual({
        success: true,
        reason: 'conversation passed',
      });
      simCtx.fail('backend state diverged');
    });
    const { remote, host, clientTransport, hostTransport } = await startConnectedClientHost(ctx);

    try {
      await expect(
        remote.finalizeSimulation({
          provisionalSuccess: true,
          provisionalReason: 'conversation passed',
        }),
      ).resolves.toMatchObject({
        userVerdict: { success: false, reason: 'backend state diverged' },
      });
      expect(clientTransport.sent).toHaveLength(1);
      expect(hostTransport.sent).toHaveLength(1);
    } finally {
      await remote.close();
      await host.close();
    }
  });

  it('propagates a callback error through connected transports', async () => {
    const ctx = fakeSimJobContext(() => {
      throw new Error('user callback exploded');
    });
    const { remote, host } = await startConnectedClientHost(ctx);

    try {
      const error = await remote
        .finalizeSimulation({ provisionalSuccess: true })
        .catch((error: unknown) => error);
      expect(error).toBeInstanceOf(FinalizeSimulationError);
      expect(error).toMatchObject({
        name: 'FinalizeSimulationError',
        message: 'user callback exploded',
        userVerdict: undefined,
      });
    } finally {
      await remote.close();
      await host.close();
    }
  });

  it('propagates the callback error without losing a fail-then-throw veto', async () => {
    const ctx = fakeSimJobContext((simCtx) => {
      simCtx.fail('backend state diverged');
      throw new Error('cleanup exploded');
    });
    const { remote, host } = await startConnectedClientHost(ctx);

    try {
      const error = await remote
        .finalizeSimulation({ provisionalSuccess: true })
        .catch((error: unknown) => error);
      expect(error).toBeInstanceOf(FinalizeSimulationError);
      expect(error).toMatchObject({
        name: 'FinalizeSimulationError',
        message: 'cleanup exploded',
        userVerdict: {
          success: false,
          reason: 'backend state diverged',
        },
      });
    } finally {
      await remote.close();
      await host.close();
    }
  });

  it('keeps generic request errors generic', async () => {
    const [clientTransport, serverTransport] = createConnectedTransportPair();
    const remote = new RemoteSession(clientTransport);
    await remote.start();
    const respond = (async () => {
      const { value: message } = await serverTransport[Symbol.asyncIterator]().next();
      const request = message.message.value as pb.SessionRequest;
      await serverTransport.sendMessage(
        new pb.AgentSessionMessage({
          message: {
            case: 'response',
            value: new pb.SessionResponse({
              requestId: request.requestId,
              error: 'generic request exploded',
            }),
          },
        }),
      );
    })();

    try {
      const error = await remote.fetchSessionState().catch((error: unknown) => error);
      await respond;
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(FinalizeSimulationError);
      expect(error).toMatchObject({ message: 'generic request exploded' });
    } finally {
      await remote.close();
      await serverTransport.close();
    }
  });
});

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

function fakeSimJobContext(onSimulationEnd?: (ctx: SimulationContext) => unknown): JobContext {
  const room = {
    name: 'room',
    on: () => room,
    off: () => room,
    isConnected: false,
    remoteParticipants: new Map(),
  };
  const ctx = new JobContext(
    {} as unknown as JobProcess,
    {
      acceptArguments: { name: 'agent', identity: 'agent', metadata: '' },
      job: {
        id: 'job-id',
        room: { name: 'room' },
        attributes: {
          'lk.simulator.dispatch': JSON.stringify({
            simulationRunId: 'SR_9',
            scenario: { label: 's', userdata: '{"target":3}' },
          }),
        },
      },
      url: 'wss://example.livekit.cloud',
      token: 'token',
      workerId: 'worker-id',
    } as unknown as RunningJobInfo,
    room as unknown as Room,
    () => {},
    () => {},
    {} as unknown as InferenceExecutor,
  );
  ctx._simulationEndFnc = onSimulationEnd;
  return ctx;
}

function finalizeMessage(requestId: string, success: boolean, reason: string) {
  return new pb.AgentSessionMessage({
    message: {
      case: 'request',
      value: new pb.SessionRequest({
        requestId,
        request: {
          case: 'finalizeSimulation',
          value: new pb.SessionRequest_FinalizeSimulation({
            provisionalSuccess: success,
            provisionalReason: reason,
          }),
        },
      }),
    },
  });
}

const fakeAgentSession = () =>
  ({
    on: () => {},
    off: () => {},
  }) as unknown as AgentSession;

describe('SessionHost finalizeSimulation', () => {
  it('runs onSimulationEnd with the simulator verdict and returns the agent veto', async () => {
    let seen: SimulationContext | undefined;
    const ctx = fakeSimJobContext((simCtx) => {
      seen = simCtx;
      expect(simCtx.simulatorVerdict).toEqual({ success: true, reason: 'all good' });
      simCtx.fail('db state diverged');
    });

    const transport = new FakeTransport();
    const host = new SessionHost(transport);
    host.registerSession(fakeAgentSession());
    await runWithJobContextAsync(ctx, async () => host.start());

    transport.push(finalizeMessage('f1', true, 'all good'));
    await vi.waitFor(() => expect(transport.sent.length).toBe(1));

    expect(seen).toBeDefined();
    expect(seen!.simulationRun).toMatchObject({ id: 'SR_9' });
    const resp = transport.sent[0]!.message.value as pb.SessionResponse;
    expect(resp.requestId).toBe('f1');
    expect(resp.response.case).toBe('finalizeSimulation');
    const value = resp.response.value as pb.SessionResponse_FinalizeSimulationResponse;
    expect(value.userVerdict?.success).toBe(false);
    expect(value.userVerdict?.reason).toBe('db state diverged');

    await host.close();
  });

  it('omits the user verdict when the agent does not veto', async () => {
    const ctx = fakeSimJobContext(() => {});
    const transport = new FakeTransport();
    const host = new SessionHost(transport);
    host.registerSession(fakeAgentSession());
    await runWithJobContextAsync(ctx, async () => host.start());

    transport.push(finalizeMessage('f2', false, 'agent never answered'));
    await vi.waitFor(() => expect(transport.sent.length).toBe(1));

    const value = (transport.sent[0]!.message.value as pb.SessionResponse).response
      .value as pb.SessionResponse_FinalizeSimulationResponse;
    expect(value.userVerdict).toBeUndefined();

    await host.close();
  });

  it('still responds when onSimulationEnd throws', async () => {
    const ctx = fakeSimJobContext(() => {
      throw new Error('user callback exploded');
    });
    const transport = new FakeTransport();
    const host = new SessionHost(transport);
    host.registerSession(fakeAgentSession());
    await runWithJobContextAsync(ctx, async () => host.start());

    transport.push(finalizeMessage('f3', true, 'fine'));
    await vi.waitFor(() => expect(transport.sent.length).toBe(1));

    const resp = transport.sent[0]!.message.value as pb.SessionResponse;
    expect(resp.response.case).toBe('finalizeSimulation');
    expect(resp.error).toBe('user callback exploded');

    await host.close();
  });

  it('preserves a failure veto when onSimulationEnd throws after fail()', async () => {
    const ctx = fakeSimJobContext((simCtx) => {
      simCtx.fail('backend state diverged');
      throw new Error('cleanup exploded');
    });
    const transport = new FakeTransport();
    const host = new SessionHost(transport);
    host.registerSession(fakeAgentSession());
    await runWithJobContextAsync(ctx, async () => host.start());

    transport.push(finalizeMessage('f4', true, 'fine'));
    await vi.waitFor(() => expect(transport.sent.length).toBe(1));

    const value = (transport.sent[0]!.message.value as pb.SessionResponse).response
      .value as pb.SessionResponse_FinalizeSimulationResponse;
    expect(value.userVerdict).toMatchObject({
      success: false,
      reason: 'backend state diverged',
    });

    await host.close();
  });

  it('responds without a job context (no simulation)', async () => {
    const transport = new FakeTransport();
    const host = new SessionHost(transport);
    host.registerSession(fakeAgentSession());
    await host.start();

    transport.push(finalizeMessage('f5', true, 'fine'));
    await vi.waitFor(() => expect(transport.sent.length).toBe(1));

    const value = (transport.sent[0]!.message.value as pb.SessionResponse).response
      .value as pb.SessionResponse_FinalizeSimulationResponse;
    expect(value.userVerdict).toBeUndefined();

    await host.close();
  });
});
