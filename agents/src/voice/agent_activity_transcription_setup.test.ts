// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AgentSession as pb } from '@livekit/protocol';
import { AudioFrame } from '@livekit/rtc-node';
import { ReadableStream, TransformStream } from 'node:stream/web';
import { beforeAll, expect, it, vi } from 'vitest';
import { tool } from '../llm/tool_context.js';
import { initializeLogger } from '../log.js';
import { SynthesizeStream, TTS } from '../tts/tts.js';
import { AsyncIterableQueue, Future, Task } from '../utils.js';
import { Agent, AgentTask } from './agent.js';
import { AgentSession } from './agent_session.js';
import type { AgentHooks } from './agent_v2.js';
import { AudioOutput, TextOutput } from './io.js';
import { SessionHost, SessionTransport } from './remote_session.js';
import type { SpeechHandle } from './speech_handle.js';
import { FakeLLM } from './testing/fake_llm.js';

beforeAll(() => initializeLogger({ pretty: false, level: 'warn' }));
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const frame = () => new AudioFrame(new Int16Array(480), 24000, 1, 480);
type Hook = NonNullable<AgentHooks<unknown>['transcriptionNode']>;
const modes = ['text', 'custom TTS', 'default TTS'] as const;
type Mode = (typeof modes)[number];

class Text extends TextOutput {
  chunks: string[] = [];
  override async captureText(text: string) {
    this.chunks.push(text);
  }
  override flush() {}
}

class Audio extends AudioOutput {
  frames = 0;
  constructor() {
    super(24000);
  }
  override async captureFrame(value: AudioFrame) {
    await super.captureFrame(value);
    this.frames++;
    this.onPlaybackStarted(Date.now());
  }
  override flush() {
    super.flush();
    if (this.pendingPlayoutSegments) {
      this.onPlaybackFinished({ playbackPosition: 0.02, interrupted: false });
    }
  }
  override clearBuffer() {
    if (this.pendingPlayoutSegments) {
      this.onPlaybackFinished({ playbackPosition: 0.02, interrupted: true });
    }
  }
}

class Provider extends SynthesizeStream {
  label = 'cooperative';
  protected async run() {
    for await (const _chunk of this.input) {
      this.queue.put({ frame: frame(), requestId: 'test', segmentId: 'test', final: true });
    }
  }
}

class Model extends TTS {
  label = 'cooperative';
  constructor() {
    super(24000, 1, { streaming: true });
  }
  synthesize(): never {
    throw new Error('streaming only');
  }
  stream() {
    return new Provider(this);
  }
}

class Transport extends SessionTransport {
  incoming = new AsyncIterableQueue<pb.AgentSessionMessage>();
  sent: pb.AgentSessionMessage[] = [];
  closed = false;
  async sendMessage(message: pb.AgentSessionMessage) {
    this.sent.push(message);
  }
  async close() {
    this.closed = true;
    this.incoming.close();
  }
  [Symbol.asyncIterator]() {
    return this.incoming[Symbol.asyncIterator]();
  }
}

function fixture(mode: Mode, hook: Hook, factory: 'Agent' | 'AgentTask' = 'Agent') {
  let producer!: ReadableStreamDefaultController<string>;
  const cancel = vi.fn();
  const source = new ReadableStream<string>({
    start(controller) {
      producer = controller;
      controller.enqueue('first');
    },
    cancel,
  });
  const tee = vi.spyOn(source, 'tee');
  const tasks: Task<unknown>[] = [];
  const from = Task.from;
  const spy = vi.spyOn(Task, 'from').mockImplementation((fn, controller, name) => {
    const task = from.call(Task, fn, controller, name);
    tasks.push(task);
    return task;
  });
  const session = new AgentSession({
    llm: new FakeLLM([{ input: 'go', toolCalls: [{ name: 'speak', args: {} }] }]),
    tts: mode === 'text' ? undefined : new Model(),
    ttsTextTransforms: [],
  });
  let speech: SpeechHandle | undefined;
  const say = () => (speech = session.say(source));
  const options = {
    instructions: 'test',
    tools: [
      tool({
        name: 'speak',
        description: 'Say text',
        execute: async () => {
          await say();
          return 'said';
        },
      }),
    ],
    transcriptionNode: hook,
  };
  const agent = factory === 'Agent' ? Agent.create(options) : AgentTask.create(options);
  let input: Parameters<Agent['transcriptionNode']>[0] | undefined;
  const transcriptionNode = agent.transcriptionNode.bind(agent);
  const transcription = vi
    .spyOn(agent, 'transcriptionNode')
    .mockImplementation((text, settings) => {
      input = text;
      return transcriptionNode(text, settings);
    });
  if (mode === 'custom TTS') {
    agent.ttsNode = async (text) =>
      (text as ReadableStream<string>).pipeThrough(
        new TransformStream<string, AudioFrame>({
          transform(_text, controller) {
            controller.enqueue(frame());
          },
        }),
      );
  }
  const text = new Text();
  const audio = new Audio();
  session.output.transcription = text;
  if (mode !== 'text') session.output.audio = audio;
  return {
    session,
    agent,
    source,
    producer,
    cancel,
    tee,
    tasks,
    text,
    audio,
    say,
    speech: () => speech!,
    input: () => input as ReadableStream<string>,
    release() {
      try {
        producer.close();
      } catch {
        /* already cancelled */
      }
    },
    restore() {
      spy.mockRestore();
      tee.mockRestore();
      transcription.mockRestore();
    },
  };
}

function bufferedHook() {
  const waiting = new Future<void>();
  let setupExited = false;
  const hook: Hook = async (_ctx, text) => {
    const input = text[Symbol.asyncIterator]();
    const first = await input.next();
    waiting.resolve();
    let second: Awaited<ReturnType<typeof input.next>>;
    try {
      second = await input.next();
    } finally {
      setupExited = true;
    }
    return (async function* () {
      if (!first.done) yield first.value;
      if (!second.done) yield second.value;
      for await (const chunk of text) yield chunk;
    })();
  };
  return { hook, waiting, exited: () => setupExited };
}

it.each(
  modes.flatMap((mode) =>
    (['session close', 'run cancellation', 'host close', 'interruption'] as const).map(
      (ending) => ({ mode, ending }),
    ),
  ),
)(
  'joins pending public transcription setup with $mode on $ending',
  async ({ mode, ending }) => {
    const hook = bufferedHook();
    const f = fixture(mode, hook.hook);
    const transport = new Transport();
    const host = new SessionHost(transport);
    let closing: Promise<void> | undefined;
    try {
      await f.session.start({ agent: f.agent });
      host.registerSession(f.session);
      const run = ending === 'run cancellation' ? f.session.run({ userInput: 'go' }) : undefined;
      if (run) void run.wait().catch(() => {});
      else if (ending === 'host close') {
        await host.start();
        transport.incoming.put(
          new pb.AgentSessionMessage({
            message: {
              case: 'request',
              value: new pb.SessionRequest({
                requestId: 'say',
                request: {
                  case: 'runInput',
                  value: new pb.SessionRequest_RunInput({ text: 'go' }),
                },
              }),
            },
          }),
        );
      } else f.say();
      await hook.waiting.await;
      await tick();
      const ownedTasks = [...f.tasks];
      let settled = false;
      if (ending === 'interruption') {
        f.speech().interrupt();
        closing = Promise.all(f.speech()._tasks.map((task) => task.result)).then(() => {});
      } else
        closing = run ? run._cancel() : ending === 'host close' ? host.close() : f.session.close();
      void closing.then(
        () => (settled = true),
        () => (settled = true),
      );
      await expect
        .poll(() => settled, { timeout: ending === 'host close' ? 5000 : 4000 })
        .toBe(true);
      await closing;
      expect(hook.exited()).toBe(true);
      expect(f.input().locked).toBe(false);
      expect(f.cancel).toHaveBeenCalledOnce();
      expect(f.speech()._tasks.length).toBeGreaterThan(0);
      expect(f.speech()._tasks.every((task) => task.done)).toBe(true);
      if (ending === 'host close') {
        expect(transport.closed).toBe(true);
        const requests = ownedTasks.filter((task) => task.name === 'runInput');
        expect(requests).toHaveLength(1);
        expect(requests[0]!.done).toBe(true);
        expect(
          transport.sent.some(
            (message) =>
              message.message.case === 'response' && message.message.value.requestId === 'say',
          ),
        ).toBe(false);
      }
      for (const branch of f.tee.mock.results[0]?.value ?? []) expect(branch.locked).toBe(false);
      if (mode === 'text') expect(f.source.locked).toBe(false);
      await f.session.close();
      expect(f.tasks.every((task) => task.done)).toBe(true);
      const history = f.session.history.toJSON();
      const chunks = [...f.text.chunks];
      const frames = f.audio.frames;
      expect(() => f.producer.enqueue('late')).toThrow();
      f.release();
      await tick();
      await tick();
      expect(f.session.history.toJSON()).toEqual(history);
      expect(f.text.chunks).toEqual(chunks);
      expect(f.audio.frames).toBe(frames);
    } finally {
      f.release();
      await closing;
      await host.close();
      await f.session.close();
      f.restore();
    }
  },
  15000,
);

it.each(modes)('preserves buffered setup input and normal history with %s', async (mode) => {
  const hook = bufferedHook();
  const f = fixture(mode, hook.hook);
  try {
    await f.session.start({ agent: f.agent });
    const speech = f.say();
    await hook.waiting.await;
    expect(f.text.chunks).toEqual([]);
    expect(f.cancel).not.toHaveBeenCalled();
    f.producer.enqueue(' second');
    f.release();
    await speech;
    expect(hook.exited()).toBe(true);
    expect(f.input().locked).toBe(false);
    expect(speech._tasks.every((task) => task.done)).toBe(true);
    expect(f.text.chunks.join('')).toBe('first second');
    expect(
      f.session.history.items.some(
        (item) =>
          item.type === 'message' &&
          item.role === 'assistant' &&
          item.textContent === 'first second' &&
          !item.interrupted,
      ),
    ).toBe(true);
    expect(f.cancel).not.toHaveBeenCalled();
    if (mode !== 'text') expect(f.audio.frames).toBeGreaterThan(0);
  } finally {
    f.release();
    await f.session.close();
    f.restore();
  }
});

it.each(modes)('cancels pipeline transcription setup with %s', async (mode) => {
  const hook = bufferedHook();
  const f = fixture(mode, hook.hook);
  f.agent.llmNode = async () => f.source;
  try {
    await f.session.start({ agent: f.agent });
    const speech = f.session.generateReply({ userInput: 'go' });
    await hook.waiting.await;
    speech.interrupt();
    await expect.poll(() => speech._tasks.every((task) => task.done), { timeout: 1000 }).toBe(true);
    expect(hook.exited()).toBe(true);
    expect(f.cancel).toHaveBeenCalledOnce();
    expect(f.source.locked).toBe(false);
    await f.session.close();
    expect(f.tasks.every((task) => task.done)).toBe(true);
    const history = f.session.history.toJSON();
    const chunks = [...f.text.chunks];
    const frames = f.audio.frames;
    expect(() => f.producer.enqueue('late')).toThrow();
    await tick();
    expect(f.session.history.toJSON()).toEqual(history);
    expect(f.text.chunks).toEqual(chunks);
    expect(f.audio.frames).toBe(frames);
  } finally {
    f.release();
    await f.session.close();
    f.restore();
  }
});

it.each(
  (['custom TTS', 'default TTS'] as const).flatMap((mode) =>
    (['null', 'early output'] as const).map((ending) => ({ mode, ending })),
  ),
)(
  'drains the pipeline producer when transcription returns $ending with $mode',
  async ({ mode, ending }) => {
    const ready = new Future<void>();
    const f = fixture(mode, async (_ctx, text) => {
      const first = await text[Symbol.asyncIterator]().next();
      ready.resolve();
      if (ending === 'null') return null;
      return (async function* () {
        if (!first.done) yield first.value;
      })();
    });
    f.agent.llmNode = async () => f.source;
    const ttsText: string[] = [];
    const ttsNode = f.agent.ttsNode.bind(f.agent);
    f.agent.ttsNode = async (text, settings) =>
      ttsNode(
        (text as ReadableStream<string>).pipeThrough(
          new TransformStream<string, string>({
            transform(chunk, controller) {
              ttsText.push(chunk);
              controller.enqueue(chunk);
            },
          }),
        ),
        settings,
      );
    try {
      await f.session.start({ agent: f.agent });
      const speech = f.session.generateReply({ userInput: 'go' });
      await ready.await;
      await tick();
      expect(f.cancel).not.toHaveBeenCalled();
      f.producer.enqueue(' second');
      f.release();
      await speech;
      expect(speech.exception()).toBeUndefined();
      expect(speech._tasks.every((task) => task.done)).toBe(true);
      expect(ttsText.join('')).toBe('first second');
      expect(f.audio.frames).toBeGreaterThan(0);
      expect(f.text.chunks).toEqual(ending === 'null' ? [] : ['first']);
      expect(f.cancel).not.toHaveBeenCalled();
    } finally {
      f.release();
      await f.session.close();
      f.restore();
    }
  },
);

it('reports an already locked transcription source without retaining the input pipe', async () => {
  const f = fixture('text', (_ctx, text) => text);
  const reader = f.source.getReader();
  try {
    await f.session.start({ agent: f.agent });
    const speech = f.say();
    await expect.poll(() => speech._tasks.every((task) => task.done)).toBe(true);
    await expect(speech._tasks[0]!.result).rejects.toBeInstanceOf(TypeError);
    expect(f.input().locked).toBe(false);
    expect(f.text.chunks).toEqual([]);
  } finally {
    reader.releaseLock();
    f.release();
    await f.session.close();
    f.restore();
  }
});

it.each(['text', 'default TTS'] as const)(
  'cancels pending AgentTask transcription setup with %s',
  async (mode) => {
    const hook = bufferedHook();
    const f = fixture(mode, hook.hook, 'AgentTask');
    try {
      await f.session.start({ agent: f.agent });
      f.say();
      await hook.waiting.await;
      await f.session.close();
      expect(hook.exited()).toBe(true);
      expect(f.cancel).toHaveBeenCalledOnce();
      expect(f.speech()._tasks.every((task) => task.done)).toBe(true);
      for (const branch of f.tee.mock.results[0]?.value ?? []) expect(branch.locked).toBe(false);
    } finally {
      f.release();
      await f.session.close();
      f.restore();
    }
  },
);

it.each(['null', 'reject', 'source error'] as const)(
  'releases setup input and preserves %s',
  async (ending) => {
    const waiting = new Future<void>();
    const release = new Future<void>();
    const failure = new Error('setup failed');
    const f = fixture('custom TTS', async (_ctx, text) => {
      const reader = text[Symbol.asyncIterator]();
      await reader.next();
      waiting.resolve();
      if (ending === 'source error') await reader.next();
      else await release.await;
      if (ending !== 'null') throw failure;
      return null;
    });
    try {
      await f.session.start({ agent: f.agent });
      const speech = f.say();
      await waiting.await;
      if (ending === 'source error') f.producer.error(failure);
      else release.resolve();
      if (ending === 'null') f.release();
      await expect.poll(() => speech._tasks.every((task) => task.done)).toBe(true);
      await speech.waitForPlayout();
      expect(speech.exception()).toBe(ending === 'null' ? undefined : failure);
      if (ending !== 'null') await expect(speech._tasks[0]!.result).rejects.toBe(failure);
      expect(f.text.chunks).toEqual([]);
      for (const branch of f.tee.mock.results[0]?.value ?? []) expect(branch.locked).toBe(false);
    } finally {
      release.resolve();
      f.release();
      await f.session.close();
      f.restore();
    }
  },
);

it.each([false, true])(
  'releases input when setup completes late after acquiring its reader: %s',
  async (acquired) => {
    const waiting = new Future<void>();
    const release = new Future<void>();
    const returned = vi.fn();
    let setup: Promise<void> | undefined;
    const f = fixture('custom TTS', async (_ctx, text) => {
      if (acquired) await text[Symbol.asyncIterator]().next();
      waiting.resolve();
      await release.await;
      setup = (async () => {
        try {
          for await (const _chunk of text) {
            /* cancelled input */
          }
        } catch {
          /* cancellation */
        }
      })();
      await setup;
      return {
        [Symbol.asyncIterator]: () => ({
          next: async () => ({ done: false, value: 'late' }),
          return: async () => {
            returned();
            return { done: true, value: undefined };
          },
        }),
      };
    });
    try {
      await f.session.start({ agent: f.agent });
      const speech = f.say();
      await waiting.await;
      await f.session.close();
      expect(f.cancel).toHaveBeenCalledOnce();
      expect(speech._tasks.every((task) => task.done)).toBe(true);
      const history = f.session.history.toJSON();
      release.resolve();
      await expect.poll(() => returned.mock.calls.length).toBe(1);
      await setup;
      expect(f.text.chunks).toEqual([]);
      expect(f.audio.frames).toBe(0);
      expect(f.session.history.toJSON()).toEqual(history);
    } finally {
      release.resolve();
      f.release();
      await f.session.close();
      f.restore();
    }
  },
);
