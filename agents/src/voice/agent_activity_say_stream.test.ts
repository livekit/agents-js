// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioFrame } from '@livekit/rtc-node';
import { ReadableStream, TransformStream } from 'node:stream/web';
import { beforeAll, expect, it, vi } from 'vitest';
import { initializeLogger } from '../log.js';
import { TTS } from '../tts/tts.js';
import { Future, Task } from '../utils.js';
import { Agent } from './agent.js';
import { AgentSession } from './agent_session.js';
import { AudioOutput, TextOutput } from './io.js';

beforeAll(() => initializeLogger({ pretty: false, level: 'warn' }));
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const frame = () => new AudioFrame(new Int16Array(480), 24000, 1, 480);

function textStream(closed = false) {
  let controller!: ReadableStreamDefaultController<string>;
  const cancel = vi.fn();
  const stream = new ReadableStream<string>({
    start(c) {
      controller = c;
      c.enqueue('early');
      if (closed) c.close();
    },
    cancel,
  });
  const tee = vi.spyOn(stream, 'tee');
  return {
    stream,
    controller,
    cancel,
    tee,
    close() {
      try {
        controller.close();
      } catch {
        /* already closed or cancelled */
      }
    },
  };
}

class Output extends TextOutput {
  captured: string[] = [];
  entered = new Future<void>();
  task?: Task<unknown>;
  constructor(private failure?: Error) {
    super();
  }
  override async captureText(text: string) {
    this.task = Task.current();
    this.captured.push(text);
    this.entered.resolve();
    if (this.failure) throw this.failure;
  }
  override flush() {}
}

class Audio extends AudioOutput {
  frames: AudioFrame[] = [];
  task?: Task<unknown>;
  constructor() {
    super(24000);
  }
  override async captureFrame(value: AudioFrame) {
    this.task = Task.current();
    await super.captureFrame(value);
    this.frames.push(value);
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

class MockTTS extends TTS {
  label = 'mock';
  constructor() {
    super(24000, 1, { streaming: true });
  }
  synthesize(): never {
    throw new Error('use the deterministic ttsNode');
  }
  stream(): never {
    throw new Error('use the deterministic ttsNode');
  }
}

const modes = ['text', 'provided audio', 'generated audio'] as const;
type Mode = (typeof modes)[number];
function fixture(mode: Mode, failure?: Error, transcription?: 'null' | 'reject') {
  const output = new Output(failure);
  const audio = new Audio();
  const ttsInput: string[] = [];
  let ttsTask: Task<unknown> | undefined;
  let transcriptionInput: ReadableStream<string> | undefined;
  const hookError = new Error('transcription hook failed');
  class TestAgent extends Agent {
    override async transcriptionNode(text: Parameters<Agent['transcriptionNode']>[0]) {
      transcriptionInput = text as ReadableStream<string>;
      if (transcription === 'null') return null;
      if (transcription === 'reject') throw hookError;
      return super.transcriptionNode(text, {});
    }
    override async ttsNode(text: ReadableStream<string>) {
      ttsTask = Task.current();
      return text.pipeThrough(
        new TransformStream<string, AudioFrame>({
          transform(chunk, controller) {
            ttsInput.push(chunk);
            controller.enqueue(frame());
          },
        }),
      );
    }
  }
  const session = new AgentSession({
    tts: mode === 'generated audio' ? new MockTTS() : undefined,
    ttsTextTransforms: [],
  });
  session.output.transcription = output;
  if (mode !== 'text') session.output.audio = audio;
  const options =
    mode === 'provided audio'
      ? {
          audio: new ReadableStream<AudioFrame>({
            start(c) {
              c.enqueue(frame());
              c.close();
            },
          }),
        }
      : undefined;
  return {
    session,
    agent: new TestAgent({ instructions: 'test' }),
    output,
    audio,
    options,
    ttsInput,
    ttsTask: () => ttsTask,
    hookError,
    transcriptionInput: () => transcriptionInput,
  };
}

it.each(modes)(
  'settles %s say with the original sink error and releases its consumers',
  async (mode) => {
    const failure = new Error('transcription sink disconnected');
    const f = fixture(mode, failure);
    const source = textStream();
    await f.session.start({ agent: f.agent });
    const speech = f.session.say(source.stream, f.options);
    try {
      await f.output.entered.await;
      await expect.poll(() => speech._tasks.every((t) => t.done), { timeout: 1000 }).toBe(true);
      await speech.waitForPlayout();
      expect(speech.exception()).toBe(failure);
      await expect(speech._tasks[0]!.result).rejects.toBe(failure);
      expect(f.output.task?.done).toBe(true);
      if (f.ttsTask()) expect(f.ttsTask()?.done).toBe(true);
      if (f.audio.task) expect(f.audio.task.done).toBe(true);
      for (const branch of source.tee.mock.results[0]?.value ?? [])
        expect(branch.locked).toBe(false);
      expect(source.cancel).toHaveBeenCalledOnce();
      expect(f.transcriptionInput()?.locked).toBe(false);
      if (mode !== 'generated audio') expect(source.stream.locked).toBe(false);
      const history = f.session.history.toJSON();
      expect(() => source.controller.enqueue('late')).toThrow();
      await tick();
      expect(f.output.captured).toEqual(['early']);
      expect(f.session.history.toJSON()).toEqual(history);
    } finally {
      source.close();
      await f.session.close();
    }
  },
);

it.each(modes)('joins %s say consumers on interruption and retains partial text', async (mode) => {
  const f = fixture(mode);
  const source = textStream();
  await f.session.start({ agent: f.agent });
  const speech = f.session.say(source.stream, f.options);
  try {
    await f.output.entered.await;
    await tick();
    f.session.interrupt({ force: true });
    await expect.poll(() => speech._tasks.every((t) => t.done), { timeout: 1000 }).toBe(true);
    expect(f.output.task?.done).toBe(true);
    if (f.ttsTask()) expect(f.ttsTask()?.done).toBe(true);
    if (f.audio.task) expect(f.audio.task.done).toBe(true);
    for (const branch of source.tee.mock.results[0]?.value ?? []) expect(branch.locked).toBe(false);
    expect(source.cancel).toHaveBeenCalledOnce();
    expect(f.transcriptionInput()?.locked).toBe(false);
    if (mode !== 'generated audio') expect(source.stream.locked).toBe(false);
    await speech.waitForPlayout();
    expect(speech.exception()).toBeUndefined();
    expect(
      f.session.history.items
        .filter((i) => i.type === 'message')
        .map((i) => i.type === 'message' && { text: i.textContent, interrupted: i.interrupted }),
    ).toEqual([{ text: 'early', interrupted: true }]);
    const history = f.session.history.toJSON();
    await f.session.close();
    expect(() => source.controller.enqueue('late')).toThrow();
    await tick();
    expect(f.output.captured).toEqual(['early']);
    expect(f.session.history.toJSON()).toEqual(history);
  } finally {
    source.close();
    await f.session.close();
  }
});

it.each(modes)('preserves normal text and audio for %s say', async (mode) => {
  const f = fixture(mode);
  const source = textStream(true);
  await f.session.start({ agent: f.agent });
  try {
    const speech = f.session.say(source.stream, f.options);
    await speech.waitForPlayout();
    expect(speech.exception()).toBeUndefined();
    expect(speech._tasks.every((t) => t.done)).toBe(true);
    expect(f.output.captured).toEqual(['early']);
    expect(f.audio.frames).toHaveLength(mode === 'text' ? 0 : 1);
    expect(f.ttsInput).toEqual(mode === 'generated audio' ? ['early'] : []);
  } finally {
    await f.session.close();
  }
});

it.each(
  modes.flatMap((mode) =>
    (['null', 'reject'] as const).map((transcription) => ({ mode, transcription })),
  ),
)(
  'cleans up $mode say when the transcription hook returns $transcription',
  async ({ mode, transcription }) => {
    const f = fixture(mode, undefined, transcription);
    const source = textStream(transcription === 'null' && mode === 'generated audio');
    await f.session.start({ agent: f.agent });
    const speech = f.session.say(source.stream, f.options);
    try {
      await expect.poll(() => speech._tasks.every((t) => t.done), { timeout: 1000 }).toBe(true);
      await speech.waitForPlayout();
      expect(speech.exception()).toBe(transcription === 'reject' ? f.hookError : undefined);
      if (transcription === 'reject' || mode !== 'generated audio')
        expect(source.cancel).toHaveBeenCalledOnce();
      expect(f.transcriptionInput()?.locked).toBe(false);
      if (transcription === 'null' && mode !== 'text') expect(f.audio.frames).toHaveLength(1);
    } finally {
      source.close();
      await f.session.close();
    }
  },
);

it.each(['null', 'reject'] as const)(
  'releases the text sibling when the TTS hook returns %s',
  async (result) => {
    const f = fixture('generated audio');
    const failure = new Error('TTS hook failed');
    vi.spyOn(f.agent, 'ttsNode').mockImplementation(async () => {
      if (result === 'reject') throw failure;
      return null;
    });
    const source = textStream(result === 'null');
    await f.session.start({ agent: f.agent });
    const speech = f.session.say(source.stream);
    try {
      await expect.poll(() => speech._tasks.every((t) => t.done), { timeout: 1000 }).toBe(true);
      await speech.waitForPlayout();
      expect(speech.exception()).toBe(result === 'reject' ? failure : undefined);
      for (const branch of source.tee.mock.results[0]?.value ?? [])
        expect(branch.locked).toBe(false);
      if (result === 'reject') expect(source.cancel).toHaveBeenCalledOnce();
    } finally {
      source.close();
      await f.session.close();
    }
  },
);

it.each(['provided audio', 'generated audio'] as const)(
  'preserves an audio sink error for %s say',
  async (mode) => {
    const f = fixture(mode);
    const failure = new Error('audio sink disconnected');
    vi.spyOn(f.audio, 'captureFrame').mockRejectedValue(failure);
    const source = textStream();
    await f.session.start({ agent: f.agent });
    const speech = f.session.say(source.stream, f.options);
    try {
      await expect.poll(() => speech._tasks.every((t) => t.done), { timeout: 1000 }).toBe(true);
      await speech.waitForPlayout();
      expect(speech.exception()).toBe(failure);
      expect(source.cancel).toHaveBeenCalledOnce();
      expect(f.output.task?.done).toBe(true);
      if (f.ttsTask()) expect(f.ttsTask()?.done).toBe(true);
    } finally {
      source.close();
      await f.session.close();
    }
  },
);

it('joins cooperative source cancellation before completing say', async () => {
  const f = fixture('text');
  const release = new Future<void>();
  const entered = new Future<void>();
  const source = new ReadableStream<string>({
    start(c) {
      c.enqueue('early');
    },
    cancel() {
      entered.resolve();
      return release.await;
    },
  });
  await f.session.start({ agent: f.agent });
  const speech = f.session.say(source);
  try {
    await f.output.entered.await;
    speech.interrupt();
    await entered.await;
    expect(f.output.task?.done).toBe(false);
    expect(speech._tasks[0]!.done).toBe(false);
    release.resolve();
    await speech._tasks[0]!.result;
    expect(f.output.task?.done).toBe(true);
    expect(source.locked).toBe(false);
  } finally {
    release.resolve();
    await f.session.close();
  }
});

it('consumes say text without a transcription sink', async () => {
  const f = fixture('text');
  f.session.output.transcription = null;
  await f.session.start({ agent: f.agent });
  try {
    const speech = f.session.say(textStream(true).stream);
    await speech.waitForPlayout();
    expect(speech.exception()).toBeUndefined();
    expect(
      f.session.history.items.some((i) => i.type === 'message' && i.textContent === 'early'),
    ).toBe(true);
  } finally {
    await f.session.close();
  }
});

it.each(modes)('cancels %s say input when interrupted before authorization', async (mode) => {
  const f = fixture(mode);
  const source = textStream();
  await f.session.start({ agent: f.agent });
  const speech = f.session.say(source.stream, f.options);
  speech.interrupt();
  try {
    await speech._tasks[0]!.result;
    expect(source.cancel).toHaveBeenCalledOnce();
    expect(source.stream.locked).toBe(false);
    expect(f.output.captured).toEqual([]);
  } finally {
    source.close();
    await f.session.close();
  }
});

it('cancels a pending TTS audio read and both text consumers on interruption', async () => {
  const f = fixture('generated audio');
  const cancelledAudio = vi.fn();
  const audio = new ReadableStream<AudioFrame>({ cancel: cancelledAudio });
  let inference: Task<unknown> | undefined;
  vi.spyOn(f.agent, 'ttsNode').mockImplementation(async () => {
    inference = Task.current();
    return audio;
  });
  const source = textStream();
  await f.session.start({ agent: f.agent });
  const speech = f.session.say(source.stream);
  try {
    await f.output.entered.await;
    await tick();
    speech.interrupt();
    await expect.poll(() => speech._tasks.every((t) => t.done), { timeout: 1000 }).toBe(true);
    expect(inference?.done).toBe(true);
    expect(f.output.task?.done).toBe(true);
    expect(cancelledAudio).toHaveBeenCalledOnce();
    expect(source.cancel).toHaveBeenCalledOnce();
    expect(audio.locked).toBe(false);
    for (const branch of source.tee.mock.results[0]?.value ?? []) expect(branch.locked).toBe(false);
  } finally {
    source.close();
    await f.session.close();
  }
});
