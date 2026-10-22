// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioFrame } from '@livekit/rtc-node';
import { ReadableStream, TransformStream } from 'node:stream/web';
import { beforeAll, expect, it, vi } from 'vitest';
import { initializeLogger } from '../log.js';
import { SynthesizeStream, TTS } from '../tts/tts.js';
import { Future, Task } from '../utils.js';
import { Agent } from './agent.js';
import { AgentSession } from './agent_session.js';
import { AgentSessionEventTypes } from './events.js';
import { AudioOutput, TextOutput } from './io.js';
import { FakeLLM } from './testing/fake_llm.js';
import type { TextTransform } from './transcription/text_transforms.js';

beforeAll(() => initializeLogger({ pretty: false, level: 'warn' }));
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const frame = () => new AudioFrame(new Int16Array(480), 24000, 1, 480);
class Output extends TextOutput {
  captured: string[] = [];
  override async captureText(text: string) {
    this.captured.push(text);
  }
  override flush() {}
}
class Audio extends AudioOutput {
  constructor() {
    super(24000);
  }
  override async captureFrame(value: AudioFrame) {
    await super.captureFrame(value);
    this.onPlaybackStarted(Date.now());
  }
  override flush() {
    super.flush();
    if (this.pendingPlayoutSegments)
      this.onPlaybackFinished({ playbackPosition: 0.02, interrupted: false });
  }
  override clearBuffer() {
    if (this.pendingPlayoutSegments)
      this.onPlaybackFinished({ playbackPosition: 0.02, interrupted: true });
  }
}

const transforms: { name: string; transforms: TextTransform[] }[] = [
  { name: 'no transforms', transforms: [] },
  {
    name: 'pipeThrough',
    transforms: [(text) => text.pipeThrough(new TransformStream<string, string>())],
  },
  { name: 'builtins', transforms: ['filter_markdown', 'filter_emoji'] },
];
it.each(
  transforms.flatMap((transform) =>
    (['hook', 'provider'] as const).map((mode) => ({ ...transform, mode })),
  ),
)(
  'finishes the actual pipeline and commits text after early $mode input close with $name',
  async ({ mode, transforms }) => {
    const ttsClosed = new Future<void>();
    const sourceCancelled = vi.fn();
    let source!: ReadableStreamDefaultController<string>;
    let llmInput!: ReadableStream<string>;
    const tasks: Task<unknown>[] = [];
    const from = Task.from;
    const spy = vi.spyOn(Task, 'from').mockImplementation((fn, controller, name) => {
      const task = from.call(Task, fn, controller, name);
      tasks.push(task);
      return task;
    });
    class EarlyStream extends SynthesizeStream {
      label = 'early';
      protected async run() {
        for await (const _text of this.input) {
          this.queue.put({ frame: frame(), requestId: 'early', segmentId: 'early', final: true });
          break;
        }
      }
      override close() {
        super.close();
        ttsClosed.resolve();
      }
    }
    class EarlyTTS extends TTS {
      label = 'early';
      constructor() {
        super(24000, 1, { streaming: true });
      }
      synthesize(): never {
        throw new Error('stream only');
      }
      stream() {
        return new EarlyStream(this);
      }
    }
    class EarlyAgent extends Agent {
      override async llmNode() {
        llmInput = new ReadableStream<string>({
          start(c) {
            source = c;
            c.enqueue('first ');
          },
          cancel: sourceCancelled,
        });
        return llmInput;
      }
      override async ttsNode(text: ReadableStream<string>) {
        if (mode === 'provider') return super.ttsNode(text, {});
        return new ReadableStream<AudioFrame>({
          async start(c) {
            const reader = text.getReader();
            try {
              await reader.read();
              await reader.cancel();
              c.enqueue(frame());
              c.close();
              ttsClosed.resolve();
            } catch (error) {
              c.error(error);
            } finally {
              reader.releaseLock();
            }
          },
        });
      }
    }
    const session = new AgentSession({
      llm: new FakeLLM(),
      tts: new EarlyTTS(),
      ttsTextTransforms: transforms,
    });
    const output = new Output();
    session.output.transcription = output;
    session.output.audio = new Audio();
    await session.start({ agent: new EarlyAgent({ instructions: 'test' }) });
    const speech = session.generateReply({ userInput: 'hello' });
    try {
      await ttsClosed.await;
      await tick();
      expect(sourceCancelled).not.toHaveBeenCalled();
      source.enqueue('second');
      source.close();
      await expect
        .poll(() => speech._tasks.every((task) => task.done), { timeout: 1000 })
        .toBe(true);
      await speech.waitForPlayout();
      const producer = tasks.find(
        (task) => task.name === 'AgentActivity.pipelineReply.produceSegments',
      );
      expect(producer?.done).toBe(true);
      await expect(producer!.result).resolves.toBeUndefined();
      const speechTasks = tasks.filter((task) =>
        [
          'performLLMInference',
          'performTTSInference',
          'performTextForwarding',
          'performAudioForwarding',
        ].includes(task.name ?? ''),
      );
      await Promise.all(speechTasks.map((task) => task.result));
      expect(speechTasks.every((task) => task.done)).toBe(true);
      expect(speech.exception()).toBeUndefined();
      expect(output.captured.join('')).toBe('first second');
      expect(
        session.history.items
          .filter((item) => item.type === 'message' && item.role === 'assistant')
          .map((item) => item.textContent),
      ).toEqual(['first second']);
      expect(llmInput.locked).toBe(false);
    } finally {
      if (!speech.done()) speech.interrupt();
      await session.close();
      spy.mockRestore();
    }
  },
);

it.each(
  (['hook', 'provider'] as const).flatMap((mode) =>
    (['error', 'interrupt', 'close'] as const).map((outcome) => ({ mode, outcome })),
  ),
)(
  'joins the pipeline input on $outcome after $mode synthesis starts',
  async ({ mode, outcome }) => {
    const entered = new Future<void>();
    const finish = new Future<void>();
    const failure = new Error('synthesis failed');
    const providerError = new Future<Error>();
    let sourceController!: ReadableStreamDefaultController<string>;
    const cancelSource = vi.fn();
    let source!: ReadableStream<string>;
    let inference: Task<unknown> | undefined;
    let producer: Task<unknown> | undefined;
    const from = Task.from;
    const spy = vi.spyOn(Task, 'from').mockImplementation((fn, controller, name) => {
      const task = from.call(Task, fn, controller, name);
      if (name === 'AgentActivity.pipelineReply.produceSegments') producer = task;
      return task;
    });
    class ControlledStream extends SynthesizeStream {
      label = 'controlled';
      protected async run() {
        for await (const _text of this.input) {
          this.queue.put({ frame: frame(), requestId: 'test', segmentId: 'test', final: true });
          entered.resolve();
          if (outcome === 'error') {
            await finish.await;
            throw failure;
          }
          return;
        }
      }
    }
    class ControlledTTS extends TTS {
      label = 'controlled';
      constructor() {
        super(24000, 1, { streaming: true });
      }
      synthesize(): never {
        throw new Error('unused');
      }
      stream() {
        return new ControlledStream(this);
      }
    }
    class TestAgent extends Agent {
      override async llmNode() {
        source = new ReadableStream<string>({
          start(c) {
            sourceController = c;
            c.enqueue('first ');
          },
          cancel: cancelSource,
        });
        return source;
      }
      override async ttsNode(text: ReadableStream<string>) {
        inference = Task.current();
        if (mode === 'provider') return super.ttsNode(text, {});
        return new ReadableStream<AudioFrame>({
          async start(c) {
            const reader = text.getReader();
            try {
              await reader.read();
              await reader.cancel();
              c.enqueue(frame());
              entered.resolve();
              if (outcome === 'error') {
                await finish.await;
                throw failure;
              }
              c.close();
            } catch (error) {
              c.error(error);
            } finally {
              reader.releaseLock();
            }
          },
        });
      }
    }
    const session = new AgentSession({
      llm: new FakeLLM(),
      tts: new ControlledTTS(),
      ttsTextTransforms: [],
    });
    session.on(AgentSessionEventTypes.Error, (event) => providerError.resolve(event.error.error));
    session.output.audio = new Audio();
    const output = new Output();
    session.output.transcription = output;
    await session.start({ agent: new TestAgent({ instructions: 'test' }) });
    const speech = session.generateReply({ userInput: 'hello' });
    try {
      await entered.await;
      await tick();
      expect(cancelSource).not.toHaveBeenCalled();
      expect(speech._tasks.every((task) => task.done)).toBe(false);
      if (outcome === 'error') {
        finish.resolve();
        if (mode === 'provider') {
          // Provider errors use the session event channel; the LLM still owns EOF.
          expect(await providerError.await).toBe(failure);
          sourceController.close();
        }
      } else if (outcome === 'interrupt') speech.interrupt();
      else await session.close();
      await expect
        .poll(() => speech._tasks.every((task) => task.done), { timeout: 1500 })
        .toBe(true);
      await speech.waitForPlayout();
      expect(inference?.done).toBe(true);
      expect(producer?.done).toBe(true);
      if (outcome === 'error' && mode === 'provider') expect(cancelSource).not.toHaveBeenCalled();
      else expect(cancelSource).toHaveBeenCalledOnce();
      expect(source.locked).toBe(false);
      if (outcome === 'error' && mode === 'hook')
        await expect(inference!.result).rejects.toBe(failure);
      expect(output.captured.join('')).toBe('first ');
      const history = session.history.toJSON();
      await tick();
      expect(session.history.toJSON()).toEqual(history);
    } finally {
      finish.resolve();
      if (!speech.done()) speech.interrupt();
      await session.close();
      spy.mockRestore();
    }
  },
);

it('preserves a transform failure and closes the segment queue after its writer rejects', async () => {
  const failure = new Error('text transform failed');
  const entered = new Future<void>();
  const cancelSource = vi.fn();
  let source!: ReadableStreamDefaultController<string>;
  let inference: Task<unknown> | undefined;
  let producer: Task<unknown> | undefined;
  const from = Task.from;
  const spy = vi.spyOn(Task, 'from').mockImplementation((fn, controller, name) => {
    const task = from.call(Task, fn, controller, name);
    if (name === 'AgentActivity.pipelineReply.produceSegments') producer = task;
    return task;
  });
  class TestTTS extends TTS {
    label = 'transform';
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
    override async llmNode() {
      return new ReadableStream<string>({
        start(c) {
          source = c;
          c.enqueue('first');
        },
        cancel: cancelSource,
      });
    }
    override async ttsNode(text: ReadableStream<string>) {
      inference = Task.current();
      return text.pipeThrough(
        new TransformStream<string, AudioFrame>({
          transform(_text, c) {
            c.enqueue(frame());
            entered.resolve();
          },
        }),
      );
    }
  }
  const session = new AgentSession({
    llm: new FakeLLM(),
    tts: new TestTTS(),
    ttsTextTransforms: [
      (text) =>
        text.pipeThrough(
          new TransformStream<string, string>({
            transform(text, c) {
              if (text === 'second') throw failure;
              c.enqueue(text);
            },
          }),
        ),
    ],
  });
  const output = new Output();
  session.output.audio = new Audio();
  session.output.transcription = output;
  await session.start({ agent: new TestAgent({ instructions: 'test' }) });
  const speech = session.generateReply({ userInput: 'hello' });
  try {
    await entered.await;
    source.enqueue('second');
    await expect.poll(() => speech._tasks.every((task) => task.done), { timeout: 1000 }).toBe(true);
    expect(producer?.done).toBe(true);
    expect(inference?.done).toBe(true);
    await expect(inference!.result).rejects.toBe(failure);
    expect(cancelSource).toHaveBeenCalledOnce();
    expect(output.captured.join('')).toBe('firstsecond');
    expect(() => source.enqueue('late')).toThrow();
  } finally {
    if (!speech.done()) speech.interrupt();
    await session.close();
    spy.mockRestore();
  }
});
