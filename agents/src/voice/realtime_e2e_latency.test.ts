// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioFrame } from '@livekit/rtc-node';
import { ReadableStream, type ReadableStreamDefaultController } from 'node:stream/web';
import { describe, expect, it } from 'vitest';
import { ChatContext, type FunctionCall } from '../llm/chat_context.js';
import {
  type GenerationCreatedEvent,
  type MessageGeneration,
  type RealtimeCapabilities,
  RealtimeModel,
  RealtimeSession,
} from '../llm/realtime.js';
import { type ToolChoice, ToolContext } from '../llm/tool_context.js';
import { initializeLogger } from '../log.js';
import type { SpeechEvent } from '../stt/stt.js';
import { SpeechEventType } from '../stt/stt.js';
import { FakeSTT } from '../stt/testing/fake_stt.js';
import { delay } from '../utils.js';
import { Agent } from './agent.js';
import { AgentSession } from './agent_session.js';
import type { AudioRecognition } from './audio_recognition.js';
import { AgentSessionEventTypes, type ConversationItemAddedEvent } from './events.js';
import { AudioOutput } from './io.js';

initializeLogger({ pretty: false, level: 'silent' });

function emptyStream<T>(): ReadableStream<T> {
  return new ReadableStream<T>({ start: (controller) => controller.close() });
}

function oneItemStream<T>(item: T): ReadableStream<T> {
  return new ReadableStream<T>({
    start(controller) {
      controller.enqueue(item);
      controller.close();
    },
  });
}

class ControlledRealtimeSession extends RealtimeSession {
  private _chatCtx = ChatContext.empty();
  private _tools = ToolContext.empty();
  private audioController?: ReadableStreamDefaultController<AudioFrame>;
  replies = 0;

  get chatCtx(): ChatContext {
    return this._chatCtx;
  }

  get tools(): ToolContext {
    return this._tools;
  }

  async updateInstructions(_instructions: string): Promise<void> {}
  async updateChatCtx(chatCtx: ChatContext): Promise<void> {
    this._chatCtx = chatCtx.copy();
  }
  async updateTools(tools: ToolContext): Promise<void> {
    this._tools = tools.copy();
  }
  updateOptions(_options: { toolChoice?: ToolChoice | null }): void {}
  pushAudio(_frame: AudioFrame): void {}
  async commitAudio(): Promise<void> {}
  async clearAudio(): Promise<void> {}
  async interrupt(): Promise<void> {}
  async truncate(): Promise<void> {}

  async generateReply(): Promise<GenerationCreatedEvent> {
    this.replies += 1;
    const audioStream = new ReadableStream<AudioFrame>({
      start: (controller) => {
        this.audioController = controller;
      },
    });
    const message: MessageGeneration = {
      messageId: `message-${this.replies}`,
      textStream: oneItemStream('Hello'),
      audioStream,
      modalities: Promise.resolve(['text', 'audio']),
    };
    return {
      messageStream: oneItemStream(message),
      functionStream: emptyStream<FunctionCall>(),
      userInitiated: true,
      responseId: `response-${this.replies}`,
    };
  }

  finishReply(): void {
    if (!this.audioController) throw new Error('reply audio stream is not ready');
    this.audioController.enqueue(new AudioFrame(new Int16Array(480), 24_000, 1, 480));
    this.audioController.close();
  }
}

class ControlledRealtimeModel extends RealtimeModel {
  readonly activeSession: ControlledRealtimeSession;

  constructor() {
    const capabilities: RealtimeCapabilities = {
      messageTruncation: false,
      turnDetection: false,
      userTranscription: false,
      autoToolReplyGeneration: false,
      audioOutput: true,
      manualFunctionCalls: false,
      midSessionChatCtxUpdate: true,
      midSessionInstructionsUpdate: true,
      midSessionToolsUpdate: true,
      perResponseToolChoice: false,
    };
    super(capabilities);
    this.activeSession = new ControlledRealtimeSession(this);
  }

  get model(): string {
    return 'controlled-realtime';
  }

  session(): RealtimeSession {
    return this.activeSession;
  }

  async close(): Promise<void> {}
}

class ImmediateOutput extends AudioOutput {
  constructor() {
    super(24_000);
  }

  override async captureFrame(frame: AudioFrame): Promise<void> {
    const segments = this.capturedPlayoutSegments;
    await super.captureFrame(frame);
    if (this.capturedPlayoutSegments > segments) this.onPlaybackStarted(Date.now());
  }

  override flush(): void {
    super.flush();
    if (this.pendingPlayoutSegments > 0) {
      this.onPlaybackFinished({ playbackPosition: 0.02, interrupted: false });
    }
  }
}

interface RecognitionInternals {
  onSTTEvent(event: SpeechEvent): Promise<void>;
}

async function waitFor(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await delay(5);
  }
}

function finalTranscript(text: string): SpeechEvent {
  return {
    type: SpeechEventType.FINAL_TRANSCRIPT,
    alternatives: [{ text, confidence: 0.9 }],
  };
}

describe('realtime manual clear E2E latency', () => {
  it.each([
    ['pending_delivery', 'none'],
    ['pending_delivery', 'before_clear'],
    ['pending_delivery', 'after_clear'],
    ['delivered', 'none'],
    ['delivered', 'before_clear'],
    ['delivered', 'after_clear'],
  ] as const)('preserves latest speech timing (%s, %s)', async (phase, nextSpeech) => {
    const model = new ControlledRealtimeModel();
    const session = new AgentSession({
      llm: model,
      stt: new FakeSTT(),
      vad: null,
      turnHandling: {
        turnDetection: 'manual',
        endpointing: { minDelay: 50, maxDelay: 50 },
      },
    });
    session.output.audio = new ImmediateOutput();
    const events: ConversationItemAddedEvent[] = [];
    session.on(AgentSessionEventTypes.ConversationItemAdded, (event) => events.push(event));
    await session.start({ agent: new Agent({ instructions: 'test' }) });
    try {
      const recognition = (session._activity as unknown as { audioRecognition: AudioRecognition })
        .audioRecognition;
      const internals = recognition as unknown as RecognitionInternals;
      await internals.onSTTEvent(finalTranscript('weather'));
      session.commitUserTurn();
      await waitFor(() => recognition.endOfTurnTask !== undefined, 'manual EOU task');

      if (nextSpeech === 'before_clear') {
        await internals.onSTTEvent(finalTranscript('next turn'));
      }
      if (phase === 'delivered') {
        await recognition.endOfTurnTask!.result;
        await waitFor(() => model.activeSession.replies === 1, 'realtime generation');
      }
      session.clearUserTurn();
      if (nextSpeech === 'after_clear') {
        await internals.onSTTEvent(finalTranscript('next turn'));
      }

      await waitFor(() => model.activeSession.replies === 1, 'realtime generation');
      model.activeSession.finishReply();
      await waitFor(
        () =>
          events.some(
            (event) =>
              event.item.type === 'message' &&
              event.item.role === 'assistant' &&
              event.item.metrics.e2eLatency !== undefined,
          ),
        'assistant E2E latency',
      );
      const assistant = events
        .map((event) => event.item)
        .find((item) => item.type === 'message' && item.role === 'assistant');
      expect(assistant?.metrics.e2eLatency).toBeGreaterThanOrEqual(0);
    } finally {
      await session.close();
    }
  });

  it('does not restore timing after a skipped manual turn', async () => {
    const model = new ControlledRealtimeModel();
    const session = new AgentSession({
      llm: model,
      vad: null,
      turnHandling: { turnDetection: null },
    });
    session.output.audio = new ImmediateOutput();
    const events: ConversationItemAddedEvent[] = [];
    session.on(AgentSessionEventTypes.ConversationItemAdded, (event) => events.push(event));
    await session.start({ agent: new Agent({ instructions: 'test' }) });
    try {
      session.clearUserTurn();
      const reply = session.generateReply({ inputModality: 'audio' });
      await waitFor(() => model.activeSession.replies === 1, 'realtime generation');
      model.activeSession.finishReply();
      await reply.waitForPlayout();
      const assistant = events
        .map((event) => event.item)
        .find((item) => item.type === 'message' && item.role === 'assistant');
      expect(assistant?.metrics.e2eLatency).toBeUndefined();
    } finally {
      await session.close();
    }
  });
});
