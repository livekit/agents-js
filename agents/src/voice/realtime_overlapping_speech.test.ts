// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioFrame } from '@livekit/rtc-node';
import {
  ReadableStream,
  type ReadableStreamDefaultController,
  TransformStream,
} from 'node:stream/web';
import { setImmediate } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import { ChatContext, type FunctionCall } from '../llm/chat_context.js';
import { type GenerationCreatedEvent, RealtimeModel, RealtimeSession } from '../llm/realtime.js';
import { ToolContext } from '../llm/tool_context.js';
import { log } from '../log.js';
import { TTS } from '../tts/tts.js';
import { Future } from '../utils.js';
import { VAD, type VADEvent, VADEventType, type VADStream } from '../vad.js';
import { Agent } from './agent.js';
import { AgentSession } from './agent_session.js';
import { AudioRecognition } from './audio_recognition.js';
import { AudioOutput, TextOutput, type TimedString } from './io.js';

class TracingAudioOutput extends AudioOutput {
  frames = 0;
  clears = 0;
  pauses = 0;
  constructor() {
    super(24_000, undefined, { pause: true });
  }
  async captureFrame(frame: AudioFrame): Promise<void> {
    await super.captureFrame(frame);
    this.frames++;
    this.onPlaybackStarted(Date.now());
  }
  flush(): void {
    super.flush();
    this.onPlaybackFinished({ playbackPosition: this.frames * 0.1, interrupted: false });
  }
  clearBuffer(): void {
    this.clears++;
    this.onPlaybackFinished({ playbackPosition: this.frames * 0.1, interrupted: true });
  }
  pause(): void {
    this.pauses++;
  }
  resume(): void {}
}

function empty<T>(): ReadableStream<T> {
  return new ReadableStream<T>({
    start(controller) {
      controller.close();
    },
  });
}

class FakeRealtimeSession extends RealtimeSession {
  chatCtx = ChatContext.empty();
  tools = ToolContext.empty();
  asks = 0;
  audio?: ReadableStreamDefaultController<AudioFrame>;
  text?: ReadableStreamDefaultController<string>;
  modalities: ('audio' | 'text')[] = ['audio', 'text'];
  async updateInstructions(): Promise<void> {}
  async updateChatCtx(context: ChatContext): Promise<void> {
    this.chatCtx = context;
  }
  async updateTools(tools: ToolContext): Promise<void> {
    this.tools = tools;
  }
  updateOptions(): void {}
  pushAudio(): void {}
  async generateReply(): Promise<GenerationCreatedEvent> {
    this.asks++;
    return this.generation(true);
  }
  generation(userInitiated: boolean): GenerationCreatedEvent {
    const modalities = this.modalities;
    const audioStream = new ReadableStream<AudioFrame>({
      start: (controller) => {
        this.audio = controller;
      },
      cancel: () => {
        this.audio = undefined;
      },
    });
    const textStream = new ReadableStream<string>({
      start: (controller) => {
        this.text = controller;
      },
      cancel: () => {
        this.text = undefined;
      },
    });
    this.audio!.enqueue(new AudioFrame(new Int16Array(2400), 24_000, 1, 2400));
    this.text!.enqueue('The weather today is');
    return {
      userInitiated,
      messageStream: new ReadableStream({
        start(controller) {
          controller.enqueue({
            messageId: 'msg-1',
            audioStream,
            textStream,
            modalities: Promise.resolve(modalities),
          });
          controller.close();
        },
      }),
      functionStream: empty<FunctionCall>(),
    };
  }
  endSpeech(): void {
    this.audio?.close();
    this.text?.close();
  }
  async commitAudio(): Promise<void> {}
  async clearAudio(): Promise<void> {}
  async interrupt(): Promise<void> {}
  async truncate(): Promise<void> {}
}

class FakeRealtimeModel extends RealtimeModel {
  activeSession!: FakeRealtimeSession;
  constructor(overlap: boolean, turnDetection = true) {
    super({
      messageTruncation: true,
      turnDetection,
      supportsOverlappingSpeech: overlap,
      userTranscription: true,
      autoToolReplyGeneration: true,
      audioOutput: true,
      manualFunctionCalls: true,
    });
  }
  get model(): string {
    return 'fake';
  }
  session(): FakeRealtimeSession {
    return (this.activeSession = new FakeRealtimeSession(this));
  }
  async close(): Promise<void> {}
}

const speechStart: VADEvent = {
  type: VADEventType.START_OF_SPEECH,
  samplesIndex: 0,
  timestamp: 0,
  speechDuration: 0,
  silenceDuration: 0,
  frames: [],
  probability: 1,
  inferenceDuration: 0,
  speaking: true,
  rawAccumulatedSilence: 0,
  rawAccumulatedSpeech: 0,
};

async function start(overlap: boolean, turnDetection = true) {
  const model = new FakeRealtimeModel(overlap, turnDetection);
  const session = new AgentSession({
    llm: model,
    vad: null,
    aecWarmupDuration: null,
    turnHandling: { turnDetection: turnDetection ? 'realtime_llm' : 'manual' },
  });
  const output = new TracingAudioOutput();
  session.output.audio = output;
  const agent = new Agent({ instructions: 'be concise' });
  await session.start({ agent });
  return { model, session, output, activity: agent.getActivityOrThrow() };
}

describe('realtime overlapping speech', () => {
  it('cancels realtime text without an unused TTS sibling when audio output is disabled', async () => {
    class UnusedTTS extends TTS {
      label = 'unused';
      constructor() {
        super(24000, 1, { streaming: true });
      }
      synthesize(): never {
        throw new Error('audio output is disabled');
      }
      stream(): never {
        throw new Error('audio output is disabled');
      }
    }
    const model = new FakeRealtimeModel(false);
    const session = new AgentSession({ llm: model, tts: new UnusedTTS(), vad: null });
    await session.start({ agent: new Agent({ instructions: 'test' }) });
    model.activeSession.modalities = ['text'];
    try {
      const speech = session.generateReply();
      await setImmediate();
      session.interrupt({ force: true });
      await expect.poll(() => speech._tasks.every((t) => t.done), { timeout: 1000 }).toBe(true);
      expect(model.activeSession.text).toBeUndefined();
    } finally {
      model.activeSession.endSpeech();
      await session.close();
    }
  });

  it('hands realtime playout from VAD to adaptive interruption after the start boundary', async () => {
    class FakeVAD extends VAD {
      label = 'fake';
      constructor() {
        super({ updateInterval: 32 });
      }
      stream(): VADStream {
        throw new Error('recognition input tasks are disabled in this test');
      }
    }

    vi.stubEnv('LIVEKIT_API_KEY', 'test');
    vi.stubEnv('LIVEKIT_API_SECRET', 'test');
    // Drive recognition events directly while retaining its speech-boundary lifecycle.
    const startRecognition = vi.spyOn(AudioRecognition.prototype, 'start').mockResolvedValue();
    const model = new FakeRealtimeModel(false, false);
    const session = new AgentSession({
      llm: model,
      vad: new FakeVAD(),
      aecWarmupDuration: null,
      turnHandling: {
        turnDetection: 'vad',
        interruption: { mode: 'adaptive', backchannelBoundary: [1000, 2000] },
      },
    });
    const output = new TracingAudioOutput();
    session.output.audio = output;
    const agent = new Agent({ instructions: 'test' });
    try {
      await session.start({ agent });
      const activity = agent.getActivityOrThrow();
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      const speech = session.generateReply();
      await setImmediate();
      expect(output.frames).toBeGreaterThan(0);
      expect(activity.interruptionByAudioActivityEnabled).toBe(true);

      await vi.advanceTimersByTimeAsync(1001);
      activity.onStartOfSpeech(speechStart);
      activity.onVADInferenceDone({ ...speechStart, speechDuration: 600 });
      expect(output.pauses).toBe(0);
      expect(speech.interrupted).toBe(false);

      activity.onEndOfSpeech();
      activity.onOverlapSpeech({
        type: 'overlapping_speech',
        isInterruption: false,
        agentEnded: false,
        detectedAt: Date.now(),
        totalDurationInS: 0.6,
        predictionDurationInS: 0,
        detectionDelayInS: 0,
        probability: 0,
        numRequests: 1,
      });
      expect(
        await activity.onEndOfTurn({
          newTranscript: '',
          transcriptConfidence: 0,
          transcriptionDelay: undefined,
          endOfUtteranceDelay: undefined,
          startedSpeakingAt: undefined,
          stoppedSpeakingAt: undefined,
          backchannelOverAgent: true,
        }),
      ).toBe(false);
      expect(model.activeSession.asks).toBe(1);
      expect(speech.interrupted).toBe(false);

      activity.onStartOfSpeech(speechStart);
      activity.onOverlapSpeech({
        type: 'overlapping_speech',
        isInterruption: true,
        agentEnded: false,
        detectedAt: Date.now(),
        totalDurationInS: 0.6,
        predictionDurationInS: 0,
        detectionDelayInS: 0,
        probability: 1,
        numRequests: 1,
      });
      expect(output.pauses).toBe(1);
      expect(session.agentState).toBe('listening');
    } finally {
      vi.useRealTimers();
      model.activeSession?.endSpeech();
      await session.close();
      startRecognition.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it.each([false, true])('handles server speech start with overlap=%s', async (overlap) => {
    const { model, session, output } = await start(overlap);
    try {
      const speech = session.generateReply();
      await setImmediate();
      expect(output.frames).toBeGreaterThan(0);
      model.activeSession.emit('input_speech_started', {});
      await setImmediate();
      expect(speech.interrupted).toBe(!overlap);
      if (overlap) {
        expect(output.clears).toBe(0);
      } else {
        await speech.waitForPlayout();
        // Audio forwarding and message cleanup each clear their output.
        expect(output.clears).toBe(2);
        expect(model.activeSession.text).toBeUndefined();
      }
      expect(session.userState).toBe('speaking');
    } finally {
      model.activeSession.endSpeech();
      await session.close();
    }
  });

  it.each([false, true])(
    'does not wait for caller silence or pause output (requested: %s)',
    async (requested) => {
      const { model, session, output, activity } = await start(true);
      try {
        activity.onStartOfSpeech(speechStart);
        if (requested) session.generateReply();
        else model.activeSession.emit('generation_created', model.activeSession.generation(false));
        await setImmediate();
        expect(output.frames).toBeGreaterThan(0);
        expect(session.agentState).toBe('speaking');
        expect(output.pauses).toBe(0);
        expect(output.clears).toBe(0);
      } finally {
        model.activeSession.endSpeech();
        await session.close();
      }
    },
  );

  it.each([
    { overlap: false, turnDetection: true },
    { overlap: true, turnDetection: false },
  ])(
    'keeps the silence gate for $overlap overlap and $turnDetection server turn detection',
    async ({ overlap, turnDetection }) => {
      const { model, session, output, activity } = await start(overlap, turnDetection);
      try {
        activity.onStartOfSpeech(speechStart);
        session.generateReply();
        await setImmediate();
        expect(model.activeSession.asks).toBe(0);
        expect(output.frames).toBe(0);
        activity.onEndOfSpeech();
        await setImmediate();
        expect(model.activeSession.asks).toBe(1);
        expect(output.frames).toBeGreaterThan(0);
      } finally {
        model.activeSession.endSpeech();
        await session.close();
      }
    },
  );

  it.each([false, true])(
    'warns when interruptions are disabled with server turn detection (overlap: %s)',
    async (overlap) => {
      const session = new AgentSession({
        llm: new FakeRealtimeModel(overlap),
        vad: null,
        turnHandling: { interruption: { enabled: false } },
      });
      const warn = vi.spyOn(log(), 'warn');
      try {
        await session.start({ agent: new Agent({ instructions: 'test' }) });
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining('allowInterruptions cannot be false'),
        );
      } finally {
        await session.close();
        warn.mockRestore();
      }
    },
  );
});

it.each(
  ['text', 'fallback TTS'].flatMap((mode) =>
    (['complete', 'interrupt', 'error', 'replacement'] as const).map((outcome) => ({
      mode,
      outcome,
    })),
  ),
)(
  'retains deferred realtime transcription input until $outcome with $mode',
  async ({ mode, outcome }) => {
    const entered = new Future<void>();
    const release = new Future<void>();
    const failure = new Error('realtime transcription setup failed');
    let input: ReadableStream<string | TimedString> | undefined;
    let setup: Promise<void> | undefined;
    class DeferredAgent extends Agent {
      override async transcriptionNode(text: ReadableStream<string | TimedString>) {
        input = text;
        let cancelled = false;
        let reader: ReadableStreamDefaultReader<string | TimedString> | undefined;
        return new ReadableStream<string>({
          start(controller) {
            setup = (async () => {
              entered.resolve();
              await release.await;
              if (cancelled) return;
              if (outcome === 'error') {
                controller.error(failure);
                return;
              }
              if (outcome === 'replacement') {
                controller.enqueue('replacement');
                controller.close();
                return;
              }
              reader = text.getReader();
              try {
                for (;;) {
                  const { done, value } = await reader.read();
                  if (done || cancelled) break;
                  controller.enqueue(String(value).toUpperCase());
                }
                if (!cancelled) controller.close();
              } catch (error) {
                controller.error(error);
              } finally {
                reader.releaseLock();
              }
            })();
          },
          async cancel() {
            cancelled = true;
            release.resolve();
            await reader?.cancel();
            await setup;
          },
        });
      }
      override async ttsNode(text: ReadableStream<string>) {
        if (outcome === 'replacement') return empty<AudioFrame>();
        return text.pipeThrough(
          new TransformStream<string, AudioFrame>({
            transform(_text, controller) {
              controller.enqueue(new AudioFrame(new Int16Array(480), 24000, 1, 480));
            },
          }),
        );
      }
    }
    class MockTTS extends TTS {
      label = 'deferred';
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
    class Output extends TextOutput {
      text: string[] = [];
      override async captureText(text: string) {
        this.text.push(text);
      }
      override flush() {}
    }
    const model = new FakeRealtimeModel(false);
    const session = new AgentSession({
      llm: model,
      vad: null,
      tts: mode === 'fallback TTS' ? new MockTTS() : undefined,
      ttsTextTransforms: [],
    });
    const output = new Output();
    session.output.transcription = output;
    if (mode === 'fallback TTS') session.output.audio = new TracingAudioOutput();
    await session.start({ agent: new DeferredAgent({ instructions: 'test' }) });
    model.activeSession.modalities = ['text'];
    const speech = session.generateReply();
    let ended = false;
    const end = () => {
      if (!ended) {
        ended = true;
        model.activeSession.endSpeech();
      }
    };
    try {
      await entered.await;
      await setImmediate();
      expect(input?.locked).toBe(false);
      expect(model.activeSession.text).toBeDefined();
      if (outcome === 'interrupt') speech.interrupt();
      else {
        if (outcome === 'complete') end();
        release.resolve();
      }
      await expect
        .poll(() => speech._tasks.every((task) => task.done), { timeout: 1000 })
        .toBe(true);
      await speech.waitForPlayout();
      await setup;
      expect(input?.locked).toBe(false);
      const expected =
        outcome === 'complete'
          ? ['THE WEATHER TODAY IS']
          : outcome === 'replacement'
            ? ['replacement']
            : [];
      expect(output.text).toEqual(expected);
      if (expected.length)
        expect(
          session.history.items.some(
            (item) =>
              item.type === 'message' &&
              item.role === 'assistant' &&
              item.textContent === expected[0],
          ),
        ).toBe(true);
      if (outcome !== 'complete') expect(model.activeSession.text).toBeUndefined();
      const history = session.history.toJSON();
      release.resolve();
      await setImmediate();
      expect(session.history.toJSON()).toEqual(history);
      expect(output.text).toEqual(expected);
    } finally {
      release.resolve();
      end();
      await session.close();
    }
  },
);
