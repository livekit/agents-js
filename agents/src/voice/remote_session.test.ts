// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AgentSession as pb } from '@livekit/protocol';
import type { Room } from '@livekit/rtc-node';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { InferenceExecutor } from '../ipc/inference_executor.js';
import {
  JobContext,
  type JobProcess,
  type RunningJobInfo,
  runWithJobContextAsync,
} from '../job.js';
import { ChatMessage } from '../llm/chat_context.js';
import { initializeLogger, log } from '../log.js';
import type { SimulationContext } from '../simulation.js';
import { Future } from '../utils.js';
import type { AgentSession } from './agent_session.js';
import { FinalizeSimulationError } from './index.js';
import { RemoteSession, SessionHost, SessionTransport } from './remote_session.js';
import {
  InMemoryTransport as FakeTransport,
  InMemoryTransport as Transport,
  createConnectedTransportPair,
  messageEvent,
} from './testing/remote_session.js';

beforeAll(() => initializeLogger({ pretty: false, level: 'warn' }));
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});

const FORWARDED_EVENTS = new Set([
  'agent_false_interruption',
  'agent_state_changed',
  'conversation_item_added',
  'debug_message',
  'eot_prediction',
  'error',
  'function_tools_executed',
  'metrics_collected',
  'overlapping_speech',
  'user_input_transcribed',
  'user_state_changed',
]);

describe('SessionTransport failures surface to the caller', () => {
  it('session host logs a failed event send instead of leaving it unhandled', async () => {
    const warn = vi.spyOn(log(), 'warn').mockImplementation(() => log());
    const transport = new (class extends SessionTransport {
      async sendMessage(): Promise<void> {
        throw new Error('room session transport is closed');
      }
      async close(): Promise<void> {}
      [Symbol.asyncIterator](): AsyncIterator<pb.AgentSessionMessage> {
        return { next: () => new Promise(() => {}) };
      }
    })();
    const host = new SessionHost(transport);
    await host.start();
    const rejections: unknown[] = [];
    const onRejection = (e: unknown) => rejections.push(e);
    process.on('unhandledRejection', onRejection);
    try {
      (host as unknown as { emitEvent: (e: pb.AgentSessionEvent['event']) => void }).emitEvent({
        case: 'debugMessage',
        value: new pb.DebugMessage(),
      });
      await new Promise((r) => setTimeout(r, 20));
    } finally {
      await host.close();
      process.off('unhandledRejection', onRejection);
    }
    expect(rejections).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.anything(), 'failed to send session event');
    warn.mockRestore();
  });
});

describe('RemoteSession request over a dead transport', () => {
  it('rejects at once and leaves nothing pending', async () => {
    const transport = new (class extends SessionTransport {
      async sendMessage(): Promise<void> {
        throw new Error('tcp session transport is closed');
      }
      async close(): Promise<void> {}
      [Symbol.asyncIterator](): AsyncIterator<pb.AgentSessionMessage> {
        return { next: () => new Promise(() => {}) };
      }
    })();
    const session = new RemoteSession(transport);
    await session.start();
    try {
      await expect(
        session.finalizeSimulation({ provisionalSuccess: true, timeout: 60_000 }),
      ).rejects.toThrow(/transport is closed/);
      const pending = (session as unknown as { pendingRequests: Map<string, unknown> })
        .pendingRequests;
      expect(pending.size).toBe(0);
    } finally {
      await session.close();
    }
  });
});

describe('SessionHost event forwarding', () => {
  it('registers every forwarded event', () => {
    const on = vi.fn();
    const session = { on, off: vi.fn() } as unknown as AgentSession;
    const host = new SessionHost(new FakeTransport());

    host.registerSession(session);

    const subscribed = new Set(on.mock.calls.map(([event]) => event));
    expect(subscribed).toEqual(FORWARDED_EVENTS);
  });

  it('unregisters every forwarded event on close', async () => {
    const off = vi.fn();
    const session = { on: vi.fn(), off } as unknown as AgentSession;
    const host = new SessionHost(new FakeTransport());

    host.registerSession(session);
    await host.start();
    await host.close();

    const unsubscribed = new Set(off.mock.calls.map(([event]) => event));
    expect(unsubscribed).toEqual(FORWARDED_EVENTS);
  });
});

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

function sendHostEvent(host: SessionHost, event: pb.AgentSessionEvent): void {
  (host as unknown as { sendEvent(event: pb.AgentSessionEvent): void }).sendEvent(event);
}

describe('session response delivery', () => {
  it('flushes the response of an in-flight request while closing', async () => {
    const [clientTransport, hostTransport] = createConnectedTransportPair();
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const session = {
      on: () => {},
      off: () => {},
      interrupt: () => ({ await: Promise.resolve() }),
      run: vi.fn(() => ({
        wait: () => waiting,
        events: [
          {
            item: new ChatMessage({
              id: 'm-slow',
              role: 'assistant',
              content: ['done'],
              interrupted: false,
              metrics: {},
              createdAt: Date.now(),
            }),
          },
        ],
      })),
    } as unknown as AgentSession;

    const host = new SessionHost(hostTransport);
    host.registerSession(session);
    await host.start();
    const client = new RemoteSession(clientTransport);
    await client.start();

    const response = client.sendMessage('order a big mac', 1000);
    await vi.waitFor(() => expect(session.run).toHaveBeenCalledOnce());
    const close = host.close();
    setTimeout(release, 50);
    await close;

    await expect(response).resolves.toMatchObject({
      items: [{ item: { case: 'message', value: { content: [{ payload: { value: 'done' } }] } } }],
    });
    await client.close();
  });

  it('logs event send failures without leaking a task rejection', async () => {
    class FailingTransport extends FakeTransport {
      override async sendMessage(_msg: pb.AgentSessionMessage): Promise<void> {
        throw new Error('transport is down');
      }
    }

    const warn = vi.spyOn(log(), 'warn');
    const host = new SessionHost(new FailingTransport());
    host.registerSession(fakeAgentSession());
    await host.start();
    sendHostEvent(host, new pb.AgentSessionEvent());

    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.any(Error) }),
        'failed to send session event',
      ),
    );
    await host.close();
  });

  it('writes events from one task in emission order', async () => {
    const sent: string[] = [];
    class RecordingTransport extends FakeTransport {
      override async sendMessage(msg: pb.AgentSessionMessage): Promise<void> {
        await new Promise((resolve) => setTimeout(resolve, 5));
        const event = msg.message.value as pb.AgentSessionEvent;
        sent.push((event.event.value as pb.AgentSessionEvent_UserInputTranscribed).transcript);
      }
    }

    const host = new SessionHost(new RecordingTransport());
    host.registerSession(fakeAgentSession());
    await host.start();
    for (let i = 0; i < 10; i += 1) sendHostEvent(host, messageEvent(String(i)));

    await host.close();
    expect(sent).toEqual(Array.from({ length: 10 }, (_, i) => String(i)));
  });

  it('waitForReady polls through a transport that is not up yet', async () => {
    const hostTransport = new FakeTransport();
    let attempts = 0;
    class LateTransport extends FakeTransport {
      override async sendMessage(msg: pb.AgentSessionMessage): Promise<void> {
        attempts += 1;
        if (attempts < 3) throw new Error('room session transport is closed');
        await super.sendMessage(msg);
      }
    }
    const late = new LateTransport();
    late.connect(hostTransport);
    hostTransport.connect(late);

    const host = new SessionHost(hostTransport);
    host.registerSession(fakeAgentSession());
    await host.start();
    const client = new RemoteSession(late);
    await client.start();

    await client.waitForReady(5000, 50);
    expect(attempts).toBeGreaterThanOrEqual(3);
    await client.close();
    await host.close();
  });

  it('waitForReady surfaces the transport error past the deadline', async () => {
    class DeadTransport extends FakeTransport {
      override async sendMessage(_msg: pb.AgentSessionMessage): Promise<void> {
        throw new Error('room session transport is closed');
      }
    }
    const client = new RemoteSession(new DeadTransport());
    await client.start();

    await expect(client.waitForReady(200, 50)).rejects.toThrow('transport is closed');
    await client.close();
  });

  it('logs cancelled requests by type', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(log(), 'warn');
    const [clientTransport, hostTransport] = createConnectedTransportPair();
    const never = new Promise<void>(() => {});
    const cancel = vi.fn(async () => {});
    const session = {
      on: () => {},
      off: () => {},
      interrupt: () => ({ await: Promise.resolve() }),
      run: () => ({ wait: () => never, _cancel: cancel, events: [] }),
    } as unknown as AgentSession;
    const host = new SessionHost(hostTransport);
    host.registerSession(session);
    await host.start();
    const client = new RemoteSession(clientTransport);
    await client.start();

    void client.sendMessage('order a big mac', 10000).catch(() => {});
    await vi.advanceTimersByTimeAsync(1);
    const close = host.close();
    await vi.advanceTimersByTimeAsync(3000);
    await close;

    expect(warn).toHaveBeenCalledWith(
      { requestTypes: ['runInput'] },
      'cancelled in-flight session requests while closing',
    );
    expect(cancel).toHaveBeenCalledOnce();
    await client.close();
  });
});

it('readiness timeouts and failed sends do not retain pending requests', async () => {
  const transport = new Transport();
  const client = new RemoteSession(transport);
  await client.start();
  cleanup.push(() => client.close());
  await expect(client.waitForReady(30, 5)).rejects.toThrow('waitForReady timed out');
  expect(
    (client as unknown as { pendingRequests: Map<string, unknown> }).pendingRequests.size,
  ).toBe(0);
  transport.sendMessage = async () => {
    throw new Error('down');
  };
  await expect(client.waitForReady(30, 5)).rejects.toThrow('down');
  expect(
    (client as unknown as { pendingRequests: Map<string, unknown> }).pendingRequests.size,
  ).toBe(0);
});

it.each(['cooperative', 'late resolve', 'late reject'] as const)(
  'bounds readiness while a send is pending: %s',
  async (settlement) => {
    const release = new Future<void>();
    let signal: AbortSignal | undefined;
    class HeldTransport extends Transport {
      override async sendMessage(_message: pb.AgentSessionMessage, abort?: AbortSignal) {
        signal = abort;
        if (settlement === 'cooperative') {
          await new Promise<void>((resolve, reject) => {
            const onAbort = () => reject(abort?.reason);
            abort?.addEventListener('abort', onAbort, { once: true });
            void release.await.then(() => {
              abort?.removeEventListener('abort', onAbort);
              resolve();
            });
          });
        } else {
          await release.await;
          if (settlement === 'late reject') throw new Error('late send failure');
        }
      }
    }
    const client = new RemoteSession(new HeldTransport());
    await client.start();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    let result: unknown;
    const waiting = client.waitForReady(100, 10).then(
      () => {
        result = 'ready';
      },
      (error) => {
        result = error;
      },
    );
    try {
      await vi.advanceTimersByTimeAsync(100);
      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toBe('waitForReady timed out');
      expect(signal?.aborted).toBe(true);
      expect(
        (client as unknown as { pendingRequests: Map<string, unknown> }).pendingRequests.size,
      ).toBe(0);
      await waiting;
    } finally {
      release.resolve();
      await vi.runAllTimersAsync();
      vi.useRealTimers();
      await waiting;
      await client.close();
    }
  },
);
