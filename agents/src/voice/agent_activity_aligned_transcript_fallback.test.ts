// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioFrame } from '@livekit/rtc-node';
import { ReadableStream } from 'node:stream/web';
import { describe, expect, it, vi } from 'vitest';
import { APIError, initializeLogger, log, tts, voice } from '../index.js';
import { alignedTranscriptOrText } from './generation.js';
import { TextOutput, type TimedString } from './io.js';

type SynthesisMode = 'timed' | 'untimed' | 'fail-before-audio' | 'fail-after-audio';

const GENERATED = 'The generated reply.';
const TIMED = 'The timed reply.';
const NO_ALIGNED_TRANSCRIPT_WARNING =
  'no aligned transcript was returned from tts, ' +
  'forwarding the generated text without word timings';

class TestAudioOutput extends voice.AudioOutput {
  constructor() {
    super(24000);
  }
  async captureFrame(frame: AudioFrame): Promise<void> {
    await super.captureFrame(frame);
    this.onPlaybackStarted(Date.now());
  }
  flush(): void {
    super.flush();
    if (this.pendingPlayoutSegments > 0)
      this.onPlaybackFinished({ playbackPosition: 0.02, interrupted: false });
  }
  clearBuffer(): void {
    super.flush();
    if (this.pendingPlayoutSegments > 0)
      this.onPlaybackFinished({ playbackPosition: 0.02, interrupted: true });
  }
}

class CaptureText extends TextOutput {
  captured: Array<string | TimedString> = [];
  flushes = 0;
  async captureText(text: string | TimedString): Promise<void> {
    this.captured.push(text);
  }
  flush(): void {
    this.flushes++;
  }
  get text(): string {
    return this.captured.map((item) => (typeof item === 'string' ? item : item.text)).join('');
  }
}

class TestSynthesis extends tts.SynthesizeStream {
  label = 'test';
  constructor(
    provider: tts.TTS,
    private readonly mode: SynthesisMode,
  ) {
    super(provider);
  }
  protected async run(): Promise<void> {
    let transcript = '';
    for await (const text of this.input) {
      if (typeof text === 'string') transcript += text;
    }
    if (!transcript.trim()) return;
    if (this.mode.startsWith('fail')) {
      if (this.mode === 'fail-after-audio') {
        this.queue.put({
          requestId: 'test',
          segmentId: 'test',
          final: false,
          frame: new AudioFrame(new Int16Array(480).fill(1), 24000, 1, 480),
        });
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new APIError('synthesis failed', { retryable: false });
    }
    this.queue.put({
      requestId: 'test',
      segmentId: 'test',
      final: true,
      frame: new AudioFrame(new Int16Array(480).fill(1), 24000, 1, 480),
      timedTranscripts:
        this.mode === 'timed'
          ? [voice.createTimedString({ text: TIMED, startTime: 0, endTime: 0.02 })]
          : undefined,
    });
  }
}

class TestTts extends tts.TTS {
  label = 'test';
  constructor(private readonly mode: SynthesisMode) {
    // Advertises alignment the same way LiveKit Inference does when the requested model
    // has an aligned transcript, whichever provider ends up serving the turn.
    super(24000, 1, { streaming: true, alignedTranscript: true });
  }
  synthesize(): tts.ChunkedStream {
    throw new Error('Streaming only');
  }
  stream(): tts.SynthesizeStream {
    return new TestSynthesis(this, this.mode);
  }
}

async function runTurn(mode: SynthesisMode) {
  initializeLogger({ pretty: false, level: 'silent' });
  const warn = vi.spyOn(log(), 'warn').mockImplementation(() => undefined);
  const provider = new TestTts(mode);
  const session = new voice.AgentSession({
    tts: provider,
    // Keep the session open after a failed synthesis so its output can be checked.
    connOptions: { ttsConnOptions: { maxRetry: 0 }, maxUnrecoverableErrors: 5 },
    llm: new voice.testing.FakeLLM([{ input: 'hello', content: GENERATED }]),
  });
  const errors: unknown[] = [];
  session.on(voice.AgentSessionEventTypes.Error, (event) => errors.push(event));
  const transcription = new CaptureText();
  session.output.audio = new TestAudioOutput();
  session.output.transcription = transcription;
  await session.start({ agent: new voice.Agent({ instructions: 'Answer the caller.' }) });
  try {
    await session.generateReply({ userInput: 'hello' }).waitForPlayout();
    const messages = session.history.items.filter(
      (item) => item.type === 'message' && item.role === 'assistant',
    );
    return {
      transcription,
      messages,
      errors,
      alignedWarnings: warn.mock.calls.filter(([message]) =>
        String(message).includes(NO_ALIGNED_TRANSCRIPT_WARNING),
      ),
    };
  } finally {
    await session.close();
    await provider.close();
    warn.mockRestore();
  }
}

describe('aligned transcript fallback in the pipeline reply', () => {
  it('forwards the generated text when the TTS returns no timed transcript', async () => {
    const { transcription, messages, errors, alignedWarnings } = await runTurn('untimed');

    expect(transcription.text).toBe(GENERATED);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ interrupted: false, content: [GENERATED] });
    expect(alignedWarnings).toHaveLength(1);
    expect(errors).toEqual([]);
  }, 10000);

  it('uses the timed transcript unchanged when the TTS returns one', async () => {
    const { transcription, messages, errors, alignedWarnings } = await runTurn('timed');

    expect(transcription.text).toBe(TIMED);
    expect(transcription.captured.every((item) => typeof item !== 'string')).toBe(true);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ interrupted: false, content: [TIMED] });
    expect(alignedWarnings).toHaveLength(0);
    expect(errors).toEqual([]);
  }, 10000);

  it.each(['fail-before-audio', 'fail-after-audio'] as const)(
    'forwards no generated text when the TTS fails without timings (%s)',
    async (mode) => {
      const { transcription, messages, errors, alignedWarnings } = await runTurn(mode);

      expect(transcription.text).toBe('');
      expect(messages.map((message) => message.content.join(''))).not.toContain(GENERATED);
      expect(alignedWarnings).toHaveLength(0);
      expect(errors.length).toBeGreaterThan(0);
    },
    10000,
  );
});

describe('alignedTranscriptOrText', () => {
  const timed = (text: string) => voice.createTimedString({ text, startTime: 0, endTime: 1 });

  function source<T>(items: T[]) {
    const stream = new ReadableStream<T>({
      start(controller) {
        for (const item of items) controller.enqueue(item);
        controller.close();
      },
    });
    return stream;
  }

  async function collect(stream: ReadableStream<string | TimedString>) {
    const out: Array<string | TimedString> = [];
    for await (const item of stream) out.push(item);
    return out;
  }

  it('forwards timed items without touching the generated text', async () => {
    const warn = vi.spyOn(log(), 'warn').mockImplementation(() => undefined);
    try {
      const items = [timed('a '), timed('b')];
      const text = source(['x']);
      const out = await collect(
        alignedTranscriptOrText(source(items), text, new AbortController().signal),
      );

      expect(out).toEqual(items);
      expect(text.locked).toBe(false);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('falls back to the generated text once when no timed item arrives', async () => {
    const warn = vi.spyOn(log(), 'warn').mockImplementation(() => undefined);
    try {
      const out = await collect(
        alignedTranscriptOrText(
          source<TimedString>([]),
          source(['Hello ', 'there.']),
          new AbortController().signal,
        ),
      );

      expect(out).toEqual(['Hello ', 'there.']);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(NO_ALIGNED_TRANSCRIPT_WARNING);
    } finally {
      warn.mockRestore();
    }
  });

  it('does not fall back when the turn is aborted before any timed item', async () => {
    const warn = vi.spyOn(log(), 'warn').mockImplementation(() => undefined);
    try {
      const controller = new AbortController();
      let closeTimed!: () => void;
      const timedTexts = new ReadableStream<TimedString>({
        start(c) {
          closeTimed = () => c.close();
        },
      });
      const text = source(['Hello.']);
      const reading = collect(alignedTranscriptOrText(timedTexts, text, controller.signal));

      controller.abort();
      closeTimed();

      expect(await reading).toEqual([]);
      expect(text.locked).toBe(false);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
