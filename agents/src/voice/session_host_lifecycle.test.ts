// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { Mutex } from '@livekit/mutex';
import { AgentSession as pb } from '@livekit/protocol';
import { type AudioFrame } from '@livekit/rtc-node';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { LLM, LLMStream } from '../llm/llm.js';
import { tool } from '../llm/tool_context.js';
import { initializeLogger, log } from '../log.js';
import { TTS } from '../tts/tts.js';
import { DEFAULT_API_CONNECT_OPTIONS, FlushSentinel } from '../types.js';
import type { AsyncIterableQueue } from '../utils.js';
import { Future, Task } from '../utils.js';
import { Agent } from './agent.js';
import { AgentSession } from './agent_session.js';
import { AudioOutput, TextOutput } from './io.js';
import { RemoteSession, SessionHost } from './remote_session.js';
import type { SpeechHandle } from './speech_handle.js';
import { FakeLLM } from './testing/fake_llm.js';
import {
  InMemoryTransport as Transport,
  createRoomTransport,
  messageEvent as event,
  request,
} from './testing/remote_session.js';
import type { RunResult } from './testing/run_result.js';

beforeAll(() => initializeLogger({ pretty: false, level: 'warn' }));
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

type HostInternals = {
  tasks: Set<Task<void>>;
  recvTask: Task<void>;
  writeTask: Task<void>;
  eventMessages: AsyncIterableQueue<pb.AgentSessionMessage>;
  sendEvent(e: pb.AgentSessionEvent): void;
};

const internals = (host: SessionHost) => host as unknown as HostInternals;

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

it('retains the initial handoff and starts one writer only after transport readiness', async () => {
  const f = createRoomTransport();
  cleanup.push(() => f.transport.close());
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
    const f = createRoomTransport();
    cleanup.push(() => f.transport.close());
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

it.each(['resolve', 'reject'] as const)(
  'closes the transport before a stalled tool say TTS hook can %s',
  async (settlement) => {
    const entered = new Future<void>();
    const release = new Future<void>();
    let speech: SpeechHandle | undefined;
    class TestTTS extends TTS {
      label = 'unused';
      constructor() {
        super(24000, 1, { streaming: true });
      }
      synthesize(): never {
        throw new Error('unused');
      }
      stream(): never {
        throw new Error('unused');
      }
    }
    class TestAgent extends Agent {
      override async ttsNode(): Promise<ReadableStream<AudioFrame> | null> {
        entered.resolve();
        await release.await;
        if (settlement === 'reject') throw new Error('late TTS failure');
        return null;
      }
    }
    class Output extends AudioOutput {
      override clearBuffer() {}
    }
    const session = new AgentSession({
      llm: new FakeLLM([
        { input: 'go', toolCalls: [{ name: 'speak', args: {} }] },
        { input: 'fresh', content: 'new reply' },
      ]),
      tts: new TestTTS(),
    });
    session.output.audio = new Output(24000);
    const agent = new TestAgent({
      instructions: 'test',
      tools: [
        tool({
          name: 'speak',
          description: 'Say text',
          execute: async () => {
            speech = session.say('hello');
            await speech;
            return 'said';
          },
        }),
      ],
    });
    const transport = new Transport();
    const host = new SessionHost(transport);
    await session.start({ agent });
    host.registerSession(session);
    await host.start();
    transport.push(
      request('held', { case: 'runInput', value: new pb.SessionRequest_RunInput({ text: 'go' }) }),
    );
    let closing: Promise<void> | undefined;
    try {
      await entered.await;
      const requests = [...internals(host).tasks];
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
      closing = host.close();
      await vi.advanceTimersByTimeAsync(3000);
      expect(transport.closed).toBe(false);
      expect(speech?.interrupted).toBe(true);
      await vi.advanceTimersByTimeAsync(2999);
      expect(transport.closed).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(transport.closed).toBe(true);
      await closing;
      expect(requests.some((task) => !task.done)).toBe(true);
      const cancelledRun = session._globalRunState!;
      expect(cancelledRun.done()).toBe(true);
      expect(cancelledRun._cancel()).toBe(cancelledRun._cancel());
      expect((await internals(host).eventMessages.next()).done).toBe(true);
      const sent = [...transport.sent];
      expect(() => session.run({ userInput: 'fresh' })).toThrow('nested runs are not supported');
      release.resolve();
      await vi.advanceTimersByTimeAsync(3000);
      await Promise.allSettled(requests.map((task) => task.result));
      expect(speech?._tasks.every((task) => task.done)).toBe(true);
      expect(transport.sent).toEqual(sent);
      expect(transport.sent.some((m) => m.message.case === 'response')).toBe(false);
      // The session becomes reusable only after the old speech has settled.
      session.output.audio = null;
      const next = session.run({ userInput: 'fresh' });
      await vi.advanceTimersByTimeAsync(100);
      await next.wait();
      expect(
        session.history.items
          .filter((item) => item.type === 'message')
          .map((item) => item.textContent),
      ).toEqual(['go', 'hello', 'fresh', 'new reply']);
    } finally {
      release.resolve();
      vi.useRealTimers();
      await closing;
      await host.close();
      await session.close();
    }
  },
  10000,
);

it('joins a tool say and cancels its open source before host and session close return', async () => {
  const first = new Future<void>();
  const captured: string[] = [];
  let forwarding: Task<unknown> | undefined;
  let speech: SpeechHandle | undefined;
  let source!: ReadableStreamDefaultController<string>;
  const cancelled = vi.fn();
  const stream = new ReadableStream<string>({
    start(c) {
      source = c;
      c.enqueue('early');
    },
    cancel: cancelled,
  });
  class Output extends TextOutput {
    async captureText(text: string) {
      forwarding = Task.current();
      captured.push(text);
      first.resolve();
    }
    flush() {}
  }
  const session = new AgentSession({
    llm: new FakeLLM([{ input: 'go', toolCalls: [{ name: 'speak', args: {} }] }]),
  });
  session.output.transcription = new Output();
  const agent = new Agent({
    instructions: 'test',
    tools: [
      tool({
        name: 'speak',
        description: 'Say text',
        execute: async () => {
          speech = session.say(stream);
          await speech;
          return 'said';
        },
      }),
    ],
  });
  const transport = new Transport();
  const host = new SessionHost(transport);
  await session.start({ agent });
  host.registerSession(session);
  await host.start();
  transport.push(
    request('say', {
      case: 'runInput',
      value: new pb.SessionRequest_RunInput({ text: 'go' }),
    }),
  );
  try {
    await first.await;
    await host.close();
    await session.close();
    expect(forwarding?.done).toBe(true);
    expect(speech?._tasks.every((t) => t.done)).toBe(true);
    expect(cancelled).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
    const history = session.history.toJSON();
    expect(
      session.history.items.some(
        (i) => i.type === 'message' && i.textContent === 'early' && i.interrupted,
      ),
    ).toBe(true);
    expect(() => source.enqueue('late')).toThrow();
    await tick();
    expect(captured).toEqual(['early']);
    expect(session.history.toJSON()).toEqual(history);
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
}, 10000);

it('joins the writer and discards queued events at the shared drain deadline', async () => {
  vi.useFakeTimers();
  const f = createRoomTransport();
  cleanup.push(() => f.transport.close());
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
  expect((await internals(host).eventMessages.next()).done).toBe(true);
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
    const f = createRoomTransport();
    cleanup.push(() => f.transport.close());
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
