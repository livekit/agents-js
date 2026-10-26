// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioFrame } from '@livekit/rtc-node';
import { describe, expect, it, vi } from 'vitest';
import { initializeLogger, tts, voice } from '../index.js';

type SynthesisMode = 'before-audio' | 'during-audio' | 'complete';

class TestAudioOutput extends voice.AudioOutput {
  frames: number[] = [];
  constructor() {
    super(24000);
  }
  async captureFrame(frame: AudioFrame): Promise<void> {
    await super.captureFrame(frame);
    this.frames.push(frame.data[0]!);
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

class TestSynthesis extends tts.SynthesizeStream {
  label = 'test';
  hasReceivedText = false;
  constructor(
    provider: tts.TTS,
    private readonly mode: SynthesisMode,
    private readonly marker: number,
  ) {
    super(provider);
  }
  protected async run(): Promise<void> {
    let transcript = '';
    for await (const text of this.input) {
      if (typeof text === 'string') transcript += text;
    }
    this.hasReceivedText = true;
    if (this.mode !== 'before-audio') {
      this.queue.put({
        requestId: 'test',
        segmentId: 'test',
        final: this.mode === 'complete',
        frame: new AudioFrame(new Int16Array(480).fill(this.marker), 24000, 1, 480),
        timedTranscripts: [
          voice.createTimedString({
            text: transcript,
            startTime: 0,
            endTime: 0.02,
          }),
        ],
      });
    }
    if (this.mode !== 'complete' && !this.abortSignal.aborted)
      await new Promise<void>((resolve) => {
        this.abortSignal.addEventListener('abort', resolve.bind(null, undefined), { once: true });
      });
  }
}

class TestTts extends tts.TTS {
  label = 'test';
  streams: TestSynthesis[] = [];
  constructor(private readonly modes: SynthesisMode[]) {
    super(24000, 1, { streaming: true, alignedTranscript: true });
  }
  synthesize(): tts.ChunkedStream {
    throw new Error('Streaming only');
  }
  stream(): tts.SynthesizeStream {
    const stream = new TestSynthesis(
      this,
      this.modes[this.streams.length] ?? 'complete',
      this.streams.length + 1,
    );
    this.streams.push(stream);
    return stream;
  }
}

async function startSession(modes: SynthesisMode[]): Promise<{
  session: voice.AgentSession;
  provider: TestTts;
  output: TestAudioOutput;
  close: () => Promise<void>;
}> {
  initializeLogger({ pretty: false, level: 'silent' });
  const provider = new TestTts(modes);
  const output = new TestAudioOutput();
  const session = new voice.AgentSession({
    tts: provider,
    llm: new voice.testing.FakeLLM([
      { input: 'first', content: 'The old reply.' },
      { input: 'correction', content: 'The corrected reply.' },
    ]),
  });
  const errors: unknown[] = [];
  session.on(voice.AgentSessionEventTypes.Error, (event) => errors.push(event));
  session.output.audio = output;
  session.output.setTranscriptionEnabled(false);
  await session.start({
    agent: new voice.Agent({ instructions: 'Answer the caller.' }),
  });
  return {
    session,
    provider,
    output,
    close: async () => {
      for (const stream of provider.streams) stream.close();
      await session.close();
      expect(errors).toEqual([]);
    },
  };
}

describe('interrupted reply cleanup', () => {
  it.each(['before-audio', 'during-audio'] as const)(
    'plays the replacement promptly after interruption %s',
    async (mode) => {
      const { session, provider, output, close } = await startSession([mode, 'complete']);
      try {
        const first = session.generateReply({ userInput: 'first' });
        await vi.waitFor(() => expect(provider.streams[0]?.hasReceivedText).toBe(true));
        if (mode === 'during-audio') await vi.waitFor(() => expect(output.frames).toEqual([1]));
        const startedAt = performance.now();
        first.interrupt();
        const replacement = session.generateReply({ userInput: 'correction' });
        await vi.waitFor(() => expect(output.frames).toContain(2), {
          timeout: 6500,
        });
        expect(performance.now() - startedAt).toBeLessThan(500);
        await replacement.waitForPlayout();
        expect(provider.streams[0]!.abortSignal.aborted).toBe(true);
        expect(output.frames).toEqual(mode === 'during-audio' ? [1, 2] : [2]);
        const messages = session.history.items.filter(
          (item) => item.type === 'message' && item.role === 'assistant',
        );
        expect(messages.at(-1)).toMatchObject({
          interrupted: false,
          content: ['The corrected reply.'],
        });
        if (mode === 'during-audio')
          expect(messages[0]).toMatchObject({
            interrupted: true,
            content: ['The old reply.'],
          });
        else expect(messages).toHaveLength(1);
      } finally {
        await close();
      }
    },
    10000,
  );

  it('releases stalled speech when the session closes', async () => {
    const { session, provider, output, close } = await startSession(['during-audio']);
    try {
      session.generateReply({ userInput: 'first' });
      await vi.waitFor(() => expect(output.frames).toEqual([1]));
      const startedAt = performance.now();
      await session.close();
      expect(performance.now() - startedAt).toBeLessThan(1000);
      expect(provider.streams[0]!.abortSignal.aborted).toBe(true);
      expect(output.frames).toEqual([1]);
    } finally {
      await close();
    }
  });
});
