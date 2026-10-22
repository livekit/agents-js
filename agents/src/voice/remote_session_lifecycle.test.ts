// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { Mutex } from '@livekit/mutex';
import { AgentSession as pb } from '@livekit/protocol';
import { ByteStreamReader, LocalParticipant, type Room } from '@livekit/rtc-node';
import * as net from 'node:net';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { LLM, LLMStream } from '../llm/llm.js';
import { initializeLogger, log } from '../log.js';
import { DEFAULT_API_CONNECT_OPTIONS, FlushSentinel } from '../types.js';
import { Future, Task } from '../utils.js';
import { Agent } from './agent.js';
import { AgentSession } from './agent_session.js';
import { TextOutput } from './io.js';
import {
  RemoteSession,
  RoomSessionTransport,
  SessionHost,
  SessionTransport,
  TcpSessionTransport,
} from './remote_session.js';
import type { SpeechHandle } from './speech_handle.js';
import type { RunResult } from './testing/run_result.js';

beforeAll(() => initializeLogger({ pretty: false, level: 'warn' }));
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function request(id: string, data: pb.SessionRequest['request']) {
  return new pb.AgentSessionMessage({
    message: { case: 'request', value: new pb.SessionRequest({ requestId: id, request: data }) },
  });
}
function event(text: string) {
  return new pb.AgentSessionEvent({
    event: {
      case: 'userInputTranscribed',
      value: new pb.AgentSessionEvent_UserInputTranscribed({ transcript: text }),
    },
  });
}
type HostInternals = {
  tasks: Set<Task<void>>;
  recvTask: Task<void>;
  writeTask: Task<void>;
  eventMessages: unknown[];
  sendEvent(e: pb.AgentSessionEvent): void;
};
const internals = (host: SessionHost) => host as unknown as HostInternals;

class Transport extends SessionTransport {
  sent: pb.AgentSessionMessage[] = [];
  closed = false;
  peer?: Transport;
  queue: pb.AgentSessionMessage[] = [];
  waiter?: (value: IteratorResult<pb.AgentSessionMessage>) => void;
  push(msg: pb.AgentSessionMessage) {
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = undefined;
      resolve({ value: msg, done: false });
    } else this.queue.push(msg);
  }
  async sendMessage(msg: pb.AgentSessionMessage) {
    this.sent.push(msg);
    this.peer?.push(msg);
  }
  async close() {
    this.closed = true;
    this.waiter?.({ value: undefined, done: true });
    this.waiter = undefined;
  }
  [Symbol.asyncIterator](): AsyncIterator<pb.AgentSessionMessage> {
    return {
      next: () => {
        const msg = this.queue.shift();
        if (msg) return Promise.resolve({ value: msg, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          this.waiter = resolve;
        });
      },
    };
  }
}
class GatedLLM extends LLM {
  started = new Future<void>();
  release = new Future<void>();
  closed = new Future<void>();
  label() {
    return 'gated-provider';
  }
  chat(params: Parameters<LLM['chat']>[0]) {
    return new GatedStream(this, {
      ...params,
      connOptions: params.connOptions ?? DEFAULT_API_CONNECT_OPTIONS,
    });
  }
}
class GatedStream extends LLMStream {
  constructor(
    private owner: GatedLLM,
    params: ConstructorParameters<typeof LLMStream>[1],
  ) {
    super(owner, params);
  }
  protected async run() {
    this.owner.started.resolve();
    await this.owner.release.await;
    this.queue.put({ id: 'gated', delta: { role: 'assistant', content: 'done' } });
  }
  override close() {
    super.close();
    this.owner.closed.resolve();
  }
}
async function realSession(llm?: GatedLLM) {
  const session = new AgentSession({ llm });
  await session.start({ agent: new Agent({ instructions: 'test', id: 'default_agent' }) });
  cleanup.push(async () => {
    llm?.release.resolve();
    await session.close();
  });
  return session;
}
function fakeRoom() {
  const sent: pb.AgentSessionMessage[] = [];
  let handler!: (reader: ByteStreamReader, info: { identity: string }) => void;
  const room = {
    isConnected: true,
    registerByteStreamHandler: vi.fn((_topic, cb) => {
      handler = cb;
    }),
    unregisterByteStreamHandler: vi.fn(),
    localParticipant: {
      streamBytes: vi.fn(async () => ({
        write: async (data: Uint8Array) => {
          sent.push(pb.AgentSessionMessage.fromBinary(data));
        },
        close: async () => {},
      })),
    },
  };
  const transport = new RoomSessionTransport(
    room as unknown as Room,
    { linkedParticipant: undefined } as never,
  );
  cleanup.push(() => transport.close());
  return {
    room,
    sent,
    transport,
    deliver: (msg: pb.AgentSessionMessage) =>
      handler(
        {
          readAll: async () => [msg.toBinary()],
          close: async () => {},
        } as unknown as ByteStreamReader,
        { identity: 'remote' },
      ),
    raw: (reader: ByteStreamReader) => handler(reader, { identity: 'remote' }),
  };
}

it('retains the initial handoff and starts one writer only after transport readiness', async () => {
  const f = fakeRoom();
  const ready = new Future<void>();
  const start = f.transport.start.bind(f.transport);
  vi.spyOn(f.transport, 'start').mockImplementation(async () => {
    await ready.await;
    await start();
  });
  const session = new AgentSession();
  const host = new SessionHost(f.transport);
  host.registerSession(session);
  await session.start({ agent: new Agent({ instructions: 'test', id: 'default_agent' }) });
  cleanup.push(() => session.close());
  const starting = host.start();
  await tick();
  expect(f.sent).toHaveLength(0);
  expect(internals(host).writeTask).toBeUndefined();
  ready.resolve();
  await starting;
  const writer = internals(host).writeTask;
  await host.close();
  expect(writer.done).toBe(true);
  expect(
    f.sent.some(
      (m) =>
        m.message.case === 'event' &&
        m.message.value.event.case === 'conversationItemAdded' &&
        m.message.value.event.value.item?.item.case === 'agentHandoff' &&
        m.message.value.event.value.item.item.value.newAgentId === 'default_agent',
    ),
  ).toBe(true);
});

it('drains a real run response while the send side is still open', async () => {
  const llm = new GatedLLM();
  const session = await realSession(llm);
  const inbound = new Transport();
  const outbound = new Transport();
  inbound.peer = outbound;
  outbound.peer = inbound;
  const host = new SessionHost(inbound);
  host.registerSession(session);
  await host.start();
  const client = new RemoteSession(outbound);
  await client.start();
  cleanup.push(() => client.close());
  const response = client.sendMessage('hello', 2000);
  await llm.started.await;
  const receiver = internals(host).recvTask;
  const closing = host.close();
  await tick();
  expect(inbound.closed).toBe(false);
  llm.release.resolve();
  await closing;
  expect((await response).items.length).toBeGreaterThan(0);
  expect(receiver.done).toBe(true);
});

it.each(['updateIo', 'runInput'] as const)(
  'does not admit a late Room %s while draining an accepted response',
  async (kind) => {
    const session = await realSession();
    const f = fakeRoom();
    const run = vi.spyOn(session, 'run');
    const update = vi.spyOn(session.output, 'setAudioEnabled');
    const gate = new Future<void>();
    const entered = new Future<void>();
    f.room.localParticipant.streamBytes.mockImplementation(async () => ({
      write: async (data: Uint8Array) => {
        entered.resolve();
        await gate.await;
        f.sent.push(pb.AgentSessionMessage.fromBinary(data));
      },
      close: async () => {},
    }));
    const host = new SessionHost(f.transport);
    host.registerSession(session);
    await host.start();
    f.deliver(request('accepted', { case: 'ping', value: new pb.SessionRequest_Ping() }));
    await entered.await;
    const receiver = internals(host).recvTask;
    const closing = host.close();
    // Resolve the pending iterator in the same turn as close, before its continuation runs.
    f.deliver(
      request(
        'late',
        kind === 'runInput'
          ? { case: 'runInput', value: new pb.SessionRequest_RunInput({ text: 'hello' }) }
          : {
              case: 'updateIo',
              value: new pb.SessionRequest_UpdateIO({ output: { audioEnabled: false } }),
            },
      ),
    );
    await tick();
    gate.resolve();
    await closing;
    expect(receiver.done).toBe(true);
    expect(run).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(
      f.sent
        .filter((m) => m.message.case === 'response')
        .map((m) => (m.message.value as pb.SessionResponse).requestId),
    ).toEqual(['accepted']);
  },
);

it('cancels the real run and releases its handles when the drain deadline expires', async () => {
  const llm = new GatedLLM();
  const session = await realSession(llm);
  const transport = new Transport();
  const run = vi.spyOn(session, 'run');
  const host = new SessionHost(transport);
  host.registerSession(session);
  await host.start();
  transport.push(
    request('slow', { case: 'runInput', value: new pb.SessionRequest_RunInput({ text: 'hello' }) }),
  );
  await llm.started.await;
  const result = run.mock.results[0]!.value as RunResult;
  const tasks = [...internals(host).tasks];
  const speeches = [...(result as unknown as { handles: Set<SpeechHandle> }).handles];
  const start = performance.now();
  await host.close();
  expect(performance.now() - start).toBeLessThan(4000);
  expect(tasks.every((task) => task.done)).toBe(true);
  expect(result.done()).toBe(true);
  expect(result._watchedHandleCount()).toBe(0);
  expect(llm.closed.done).toBe(true);
  expect(session._globalRunState).toBeUndefined();
  expect(speeches.every((handle) => handle._tasks.every((task) => task.done))).toBe(true);
  llm.release.resolve();
  await tick();
  await tick();
  expect(transport.sent.some((m) => m.message.case === 'response')).toBe(false);
  expect(
    session.history.items.some(
      (item) => item.type === 'message' && item.role === 'assistant' && item.textContent === 'done',
    ),
  ).toBe(false);
}, 8000);

it('joins the writer and discards queued events at the shared drain deadline', async () => {
  vi.useFakeTimers();
  const f = fakeRoom();
  const gate = new Future<void>();
  const entered = new Future<void>();
  const closeWriter = vi.fn(async () => {});
  f.room.localParticipant.streamBytes.mockImplementation(async () => ({
    write: async () => {
      entered.resolve();
      await gate.await;
    },
    close: closeWriter,
  }));
  const host = new SessionHost(f.transport);
  await host.start();
  internals(host).sendEvent(event('a'));
  internals(host).sendEvent(event('b'));
  await entered.await;
  const writer = internals(host).writeTask;
  const closing = host.close();
  await vi.advanceTimersByTimeAsync(3001);
  await closing;
  expect(writer.done).toBe(true);
  expect(internals(host).eventMessages).toHaveLength(0);
  gate.resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(f.room.localParticipant.streamBytes).toHaveBeenCalledTimes(1);
  expect(closeWriter).toHaveBeenCalledOnce();
});

it.each(['interrupt', 'session close', 'host close'] as const)(
  'joins pending text forwarding and preserves partial history on %s',
  async (ending) => {
    const captured: string[] = [];
    const first = new Future<void>();
    const cancelled = vi.fn();
    let source!: ReadableStreamDefaultController<string>;
    let stream!: ReadableStream<string>;
    let forwardTask: Task<unknown> | undefined;
    class Output extends TextOutput {
      async captureText(text: string) {
        forwardTask = Task.current();
        captured.push(text);
        first.resolve();
      }
      flush() {}
    }
    class TestAgent extends Agent {
      override async llmNode() {
        return new ReadableStream<string>({
          start(c) {
            c.enqueue('reply');
            c.close();
          },
        });
      }
      override async transcriptionNode() {
        stream = new ReadableStream<string>({
          start(c) {
            source = c;
            c.enqueue('early');
          },
          cancel: cancelled,
        });
        return stream;
      }
    }
    const session = new AgentSession({ llm: new GatedLLM() });
    session.output.transcription = new Output();
    await session.start({ agent: new TestAgent({ instructions: 'test' }) });
    const transport = new Transport();
    const host = new SessionHost(transport);
    host.registerSession(session);
    await host.start();
    const run = vi.spyOn(session, 'run');
    transport.push(
      request('held', {
        case: 'runInput',
        value: new pb.SessionRequest_RunInput({ text: 'hello' }),
      }),
    );
    try {
      await first.await;
      await tick();
      const result = run.mock.results[0]!.value as RunResult;
      const handles = [...(result as unknown as { handles: Set<SpeechHandle> }).handles];
      if (ending === 'interrupt') {
        await session.interrupt({ force: true }).await;
        await Promise.all(handles.map((h) => h.waitForPlayout()));
        await tick();
      } else if (ending === 'session close') await session.close();
      else await host.close();
      expect(forwardTask?.done).toBe(true);
      expect(handles.every((h) => h._tasks.every((t) => t.done))).toBe(true);
      expect(cancelled).toHaveBeenCalledOnce();
      expect(stream.locked).toBe(false);
      const history = session.history.toJSON();
      expect(
        session.history.items
          .filter((i) => i.type === 'message' && i.role === 'assistant')
          .map((i) => ({ text: i.textContent, interrupted: i.interrupted })),
      ).toEqual([{ text: 'early', interrupted: true }]);
      await host.close();
      await session.close();
      expect(() => source.enqueue('late')).toThrow();
      await tick();
      expect(captured).toEqual(['early']);
      expect(session.history.toJSON()).toEqual(history);
      if (ending === 'host close')
        expect(transport.sent.some((m) => m.message.case === 'response')).toBe(false);
    } finally {
      try {
        source.close();
      } catch {
        /* already cancelled */
      }
      await host.close();
      await session.close();
    }
  },
  10000,
);

it.each(['resolve', 'reject'] as const)(
  'joins SDK reply work before a cancelled transcription hook can %s',
  async (settlement) => {
    const entered = new Future<void>();
    const release = new Future<void>();
    const cancelled = vi.fn();
    let replyTask: Task<unknown> | undefined;
    let segments = 0;
    class TestAgent extends Agent {
      override async llmNode() {
        return new ReadableStream<string | typeof FlushSentinel>({
          start(c) {
            c.enqueue('first');
            c.enqueue(FlushSentinel);
            c.enqueue('second');
            c.close();
          },
        });
      }
      override async transcriptionNode(text: Parameters<Agent['transcriptionNode']>[0]) {
        const chunks: string[] = [];
        for await (const part of text) chunks.push(String(part));
        if (++segments === 2) {
          replyTask = Task.current();
          entered.resolve();
          await release.await;
          if (settlement === 'reject') throw new Error('late transcription failure');
        }
        return new ReadableStream<string>({
          start(c) {
            chunks.forEach((chunk) => c.enqueue(chunk));
            c.close();
          },
          cancel: cancelled,
        });
      }
    }
    const session = new AgentSession({ llm: new GatedLLM() });
    await session.start({ agent: new TestAgent({ instructions: 'test' }) });
    const transport = new Transport();
    const host = new SessionHost(transport);
    host.registerSession(session);
    await host.start();
    transport.push(
      request('held', {
        case: 'runInput',
        value: new pb.SessionRequest_RunInput({ text: 'hello' }),
      }),
    );
    try {
      await entered.await;
      await host.close();
      expect(replyTask?.done).toBe(true);
      const history = session.history.toJSON();
      expect(
        session.history.items
          .filter((i) => i.type === 'message' && i.role === 'assistant')
          .map((i) => ({ text: i.textContent, interrupted: i.interrupted })),
      ).toEqual([{ text: 'first', interrupted: true }]);
      await session.close();
      release.resolve();
      await tick();
      await tick();
      expect(session.history.toJSON()).toEqual(history);
      expect(transport.sent.some((m) => m.message.case === 'response')).toBe(false);
      expect(cancelled).toHaveBeenCalledTimes(settlement === 'resolve' ? 1 : 0);
    } finally {
      release.resolve();
      await host.close();
      await session.close();
    }
  },
  12000,
);

it.each(['open', 'write', 'close'] as const)(
  'releases a native RTC writer after an aborted %s settles',
  async (phase) => {
    const previousFfi = globalThis._ffiClientInstance;
    const entered = new Future<void>();
    const release = new Future<void>();
    const operations: string[] = [];
    const participant = {
      ffi_handle: { handle: 100n },
      identity: 'test',
      disconnectSignal: new AbortController().signal,
      openStreamWriters: new Set<bigint>(),
      byteStreamWriterWrite: async () => {
        operations.push('write');
        if (phase === 'write') {
          entered.resolve();
          await release.await;
        }
      },
      byteStreamWriterClose: async () => {
        operations.push('close');
        if (phase === 'close') {
          entered.resolve();
          await release.await;
        }
      },
      streamBytes: LocalParticipant.prototype.streamBytes,
    };
    globalThis._ffiClientInstance = {
      request: () => ({ asyncId: 1n }),
      waitFor: async () => {
        if (phase === 'open') {
          entered.resolve();
          await release.await;
        }
        operations.push('open');
        return {
          result: {
            case: 'writer',
            value: {
              handle: { id: 200n },
              info: {
                streamId: 'test',
                name: 'test',
                mimeType: 'application/octet-stream',
                topic: 'lk.agent.session',
                timestamp: 0n,
                attributes: {},
              },
            },
          },
        };
      },
    } as never;
    const transport = new RoomSessionTransport(
      { isConnected: true, localParticipant: participant } as unknown as Room,
      { linkedParticipant: undefined } as never,
    );
    try {
      const sending = transport.sendMessage(new pb.AgentSessionMessage()).catch((e) => e);
      await entered.await;
      const queued = transport.sendMessage(new pb.AgentSessionMessage()).catch((e) => e);
      await transport.close();
      expect(await sending).toBeInstanceOf(Error);
      expect(await queued).toBeInstanceOf(Error);
      release.resolve();
      await tick();
      expect(participant.openStreamWriters.size).toBe(0);
      expect(operations).toEqual(phase === 'open' ? ['open', 'close'] : ['open', 'write', 'close']);
    } finally {
      release.resolve();
      await transport.close();
      await tick();
      globalThis._ffiClientInstance = previousFfi;
    }
  },
);

it('uses one deadline for accepted handlers and the event writer', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const transport = new Transport();
  const responseGate = new Future<void>();
  const eventGate = new Future<void>();
  transport.sendMessage = async (msg) => {
    if (msg.message.case === 'response') await responseGate.await;
    else await eventGate.await;
  };
  const host = new SessionHost(transport);
  host.registerSession(new AgentSession());
  await host.start();
  transport.push(request('accepted', { case: 'ping', value: new pb.SessionRequest_Ping() }));
  await vi.advanceTimersByTimeAsync(0);
  internals(host).sendEvent(event('a'));
  const writer = internals(host).writeTask;
  const closing = host.close();
  let closed = false;
  void closing.then(() => {
    closed = true;
  });
  await vi.advanceTimersByTimeAsync(2000);
  responseGate.resolve();
  await vi.advanceTimersByTimeAsync(999);
  expect(closed).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(closed).toBe(true);
  expect(writer.done).toBe(true);
  eventGate.resolve();
  await closing;
});

it('does not start a cancelled run after the activity transition unlocks', async () => {
  const session = await realSession();
  const lock = (session as unknown as { activityLock: Mutex }).activityLock;
  const unlock = await lock.lock();
  const generate = vi.spyOn(session, 'generateReply');
  const run = vi.spyOn(session, 'run');
  const transport = new Transport();
  const host = new SessionHost(transport);
  host.registerSession(session);
  await host.start();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  transport.push(
    request('locked', {
      case: 'runInput',
      value: new pb.SessionRequest_RunInput({ text: 'hello' }),
    }),
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(run).toHaveBeenCalledOnce();
  const closing = host.close();
  await vi.advanceTimersByTimeAsync(3000);
  await closing;
  unlock();
  await vi.advanceTimersByTimeAsync(0);
  expect(generate).not.toHaveBeenCalled();
  expect(session._globalRunState).toBeUndefined();
});

it.each(['open', 'write'] as const)(
  'cancels queued Room sends without resuming a stalled %s',
  async (phase) => {
    const f = fakeRoom();
    const gate = new Future<void>();
    const entered = new Future<void>();
    const writer = {
      write: vi.fn(async () => {
        if (phase === 'write') {
          entered.resolve();
          await gate.await;
        }
      }),
      close: vi.fn(async () => {}),
    };
    f.room.localParticipant.streamBytes.mockImplementation(async () => {
      if (phase === 'open') {
        entered.resolve();
        await gate.await;
      }
      return writer;
    });
    const first = f.transport.sendMessage(new pb.AgentSessionMessage()).catch((error) => error);
    await entered.await;
    const second = f.transport.sendMessage(new pb.AgentSessionMessage()).catch((error) => error);
    await f.transport.close();
    expect(await first).toBeInstanceOf(Error);
    expect(await second).toBeInstanceOf(Error);
    gate.resolve();
    await tick();
    expect(f.room.localParticipant.streamBytes).toHaveBeenCalledTimes(1);
    expect(writer.write).toHaveBeenCalledTimes(phase === 'write' ? 1 : 0);
    expect(writer.close).toHaveBeenCalledOnce();
  },
);

it('stops all Room sends when an active sender is aborted', async () => {
  const f = fakeRoom();
  const gate = new Future<void>();
  const entered = new Future<void>();
  f.room.localParticipant.streamBytes.mockImplementation(async () => ({
    write: async () => {
      entered.resolve();
      await gate.await;
    },
    close: async () => {},
  }));
  const controller = new AbortController();
  const first = f.transport
    .sendMessage(new pb.AgentSessionMessage(), controller.signal)
    .catch((error) => error);
  await entered.await;
  const queued = f.transport.sendMessage(new pb.AgentSessionMessage()).catch((error) => error);
  controller.abort();
  expect(await first).toBeInstanceOf(Error);
  expect(await queued).toBeInstanceOf(Error);
  gate.resolve();
  await tick();
  expect(f.room.localParticipant.streamBytes).toHaveBeenCalledTimes(1);
});

it.each(['open', 'write', 'close'] as const)(
  'consumes a late Room %s failure and releases acquired writers',
  async (stage) => {
    const f = fakeRoom();
    const entered = new Future<void>();
    const release = new Future<void>();
    const fail = async () => {
      entered.resolve();
      await release.await;
      throw new Error(`${stage} failed after close`);
    };
    const writer = {
      write: vi.fn(stage === 'write' ? fail : async () => {}),
      close: vi.fn(stage === 'close' ? fail : async () => {}),
    };
    f.room.localParticipant.streamBytes.mockImplementation(async () => {
      if (stage === 'open') await fail();
      return writer;
    });
    const sending = f.transport.sendMessage(new pb.AgentSessionMessage()).catch((e) => e);
    await entered.await;
    await f.transport.close();
    expect(await sending).toBeInstanceOf(Error);
    release.resolve();
    await tick();
    expect(writer.close).toHaveBeenCalledTimes(stage === 'open' ? 0 : 1);
    expect(f.room.localParticipant.streamBytes).toHaveBeenCalledOnce();
  },
);

it('closes active and queued RTC readers and joins the single read task', async () => {
  const f = fakeRoom();
  await f.transport.start();
  const cancelled = [vi.fn(), vi.fn()];
  const readers = cancelled.map(
    (cancel) =>
      new ByteStreamReader(
        {
          id: 'test',
          mimeType: 'application/octet-stream',
          topic: 'test',
          timestamp: 0,
          attributes: {},
          name: 'test',
        },
        new ReadableStream({ cancel }),
      ),
  );
  const task = (f.transport as unknown as { readTask: Task<void> }).readTask;
  const create = vi.spyOn(Task, 'from');
  readers.forEach((reader) => f.raw(reader));
  await tick();
  expect(create).not.toHaveBeenCalled();
  await f.transport.close();
  expect(task.done).toBe(true);
  cancelled.forEach((cancel) => expect(cancel).toHaveBeenCalledTimes(1));
});

it('continues after a recoverable event error without creating per-event tasks', async () => {
  const sent: string[] = [];
  const transport = new Transport();
  transport.sendMessage = async (m) => {
    const text = (
      (m.message.value as pb.AgentSessionEvent).event
        .value as pb.AgentSessionEvent_UserInputTranscribed
    ).transcript;
    if (text === 'a') throw new Error('down');
    sent.push(text);
  };
  const host = new SessionHost(transport);
  await host.start();
  const create = vi.spyOn(Task, 'from');
  const warn = vi.spyOn(log(), 'warn');
  internals(host).sendEvent(event('a'));
  internals(host).sendEvent(event('b'));
  internals(host).sendEvent(event('c'));
  await host.close();
  expect(sent).toEqual(['b', 'c']);
  expect(create).not.toHaveBeenCalled();
  expect(warn).toHaveBeenCalledWith(
    expect.objectContaining({ error: expect.any(Error) }),
    'failed to send session event',
  );
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
    cleanup.push(async () => {
      await transport.close();
      peer.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    return { transport, peer, socket: (transport as unknown as { socket: net.Socket }).socket };
  }
  it('rejects writes after peer disconnect', async () => {
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

  it('keeps accepted TCP responses writable after intake aborts', async () => {
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
  it('rejects a backpressured valid-size frame when a real peer resets', async () => {
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
