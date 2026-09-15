// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioFrame } from '@livekit/rtc-node';
import { ReadableStream, type ReadableStreamDefaultController } from 'node:stream/web';
import { setImmediate } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import { ChatContext, type FunctionCall } from '../llm/chat_context.js';
import { type GenerationCreatedEvent, RealtimeModel, RealtimeSession } from '../llm/realtime.js';
import { ToolContext } from '../llm/tool_context.js';
import { log } from '../log.js';
import { type VADEvent, VADEventType } from '../vad.js';
import { Agent } from './agent.js';
import { AgentSession } from './agent_session.js';
import { AudioOutput } from './io.js';

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
            modalities: Promise.resolve(['audio', 'text'] as ('audio' | 'text')[]),
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
  it.each([false, true])('handles server speech start with overlap=%s', async (overlap) => {
    const { model, session, output } = await start(overlap);
    try {
      const speech = session.generateReply();
      await setImmediate();
      expect(output.frames).toBeGreaterThan(0);
      model.activeSession.emit('input_speech_started', {});
      await setImmediate();
      expect(speech.interrupted).toBe(!overlap);
      expect(output.clears).toBe(overlap ? 0 : 1);
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
