// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioFrame } from '@livekit/rtc-node';
import { ReadableStream } from 'node:stream/web';
import { describe, expect, it, vi } from 'vitest';
import { ChatContext, FunctionCall } from '../llm/chat_context.js';
import {
  type GenerationCreatedEvent,
  type MessageGeneration,
  type RealtimeCapabilities,
  RealtimeModel,
  RealtimeSession,
} from '../llm/realtime.js';
import { type ToolChoice, ToolContext, tool } from '../llm/tool_context.js';
import { initializeLogger } from '../log.js';
import { Future } from '../utils.js';
import { Agent } from './agent.js';
import { AgentSession } from './agent_session.js';
import { AgentSessionEventTypes, type SpeechCreatedEvent } from './events.js';
import { AudioOutput } from './io.js';
import type { SpeechHandle } from './speech_handle.js';

initializeLogger({ pretty: false, level: 'silent' });

class StreamChannel<T> {
  readonly stream: ReadableStream<T>;
  private controller!: ReadableStreamDefaultController<T>;
  private closed = false;

  constructor() {
    this.stream = new ReadableStream<T>({
      start: (controller) => {
        this.controller = controller;
      },
      cancel: () => {
        this.closed = true;
      },
    });
  }

  send(value: T): void {
    this.controller.enqueue(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.controller.close();
  }
}

class BufferedAudioOutput extends AudioOutput {
  readonly started = new Future<void>();
  private paused = false;

  constructor() {
    super(24_000, undefined, { pause: true });
  }

  override async captureFrame(frame: AudioFrame): Promise<void> {
    const firstFrame = this.pendingPlayoutSegments === 0;
    await super.captureFrame(frame);
    if (firstFrame) {
      this.onPlaybackStarted(Date.now());
      this.started.resolve();
    }
  }

  override pause(): void {
    this.paused = true;
  }

  override resume(): void {
    this.paused = false;
    this.finish();
  }

  override clearBuffer(): void {
    if (this.pendingPlayoutSegments > 0) {
      this.onPlaybackFinished({ playbackPosition: 0.1, interrupted: true });
    }
  }

  finish(): void {
    if (!this.paused && this.pendingPlayoutSegments > 0) {
      this.onPlaybackFinished({ playbackPosition: 1, interrupted: false });
    }
  }
}

class FakeRealtimeSession extends RealtimeSession {
  private _chatCtx = ChatContext.empty();
  private _tools = ToolContext.empty();
  readonly replyFutures: Future<GenerationCreatedEvent>[] = [];
  interruptCalls = 0;

  get chatCtx(): ChatContext {
    return this._chatCtx;
  }

  get tools(): ToolContext {
    return this._tools;
  }

  get interrupted(): boolean {
    return this.interruptCalls > 0;
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

  async generateReply(
    _instructions?: string,
    options?: { signal?: AbortSignal },
  ): Promise<GenerationCreatedEvent> {
    const future = new Future<GenerationCreatedEvent>();
    this.replyFutures.push(future);
    options?.signal?.addEventListener(
      'abort',
      () => {
        if (!future.done) this.interruptCalls++;
      },
      { once: true },
    );
    return future.await;
  }

  async commitAudio(): Promise<void> {}

  async clearAudio(): Promise<void> {}

  async interrupt(): Promise<void> {
    this.interruptCalls++;
  }

  async truncate(): Promise<void> {}
}

class FakeRealtimeModel extends RealtimeModel {
  readonly activeSession = new FakeRealtimeSession(this);

  constructor() {
    super({
      messageTruncation: false,
      turnDetection: false,
      userTranscription: false,
      autoToolReplyGeneration: true,
      audioOutput: true,
      manualFunctionCalls: false,
      midSessionChatCtxUpdate: true,
    } satisfies RealtimeCapabilities);
  }

  get model(): string {
    return 'fake-realtime';
  }

  session(): RealtimeSession {
    return this.activeSession;
  }

  async close(): Promise<void> {}
}

function audioFrame(durationInS = 1): AudioFrame {
  const samples = 24_000 * durationInS;
  return new AudioFrame(new Int16Array(samples), 24_000, 1, samples);
}

function emptyGeneration(responseId: string, userInitiated = true): GenerationCreatedEvent {
  const messages = new StreamChannel<MessageGeneration>();
  const functions = new StreamChannel<FunctionCall>();
  messages.close();
  functions.close();
  return {
    messageStream: messages.stream,
    functionStream: functions.stream,
    userInitiated,
    responseId,
  };
}

async function settleStreams(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function speakingReply(agent: Agent = new Agent({ instructions: 'test' })) {
  const model = new FakeRealtimeModel();
  const audioOutput = new BufferedAudioOutput();
  const session = new AgentSession({
    llm: model,
    vad: null,
    turnHandling: { turnDetection: null },
  });
  session.output.audio = audioOutput;
  await session.start({ agent });

  const handle = session.generateReply();
  await vi.waitFor(() => expect(model.activeSession.replyFutures).toHaveLength(1));

  const messages = new StreamChannel<MessageGeneration>();
  const functions = new StreamChannel<FunctionCall>();
  const text = new StreamChannel<string>();
  const audio = new StreamChannel<AudioFrame>();
  messages.send({
    messageId: 'message-id',
    textStream: text.stream,
    audioStream: audio.stream,
    modalities: Promise.resolve(['audio', 'text']),
  });
  messages.close();
  text.send('a message the app cuts short');
  text.close();
  audio.send(audioFrame());
  audio.close();
  model.activeSession.replyFutures[0]!.resolve({
    messageStream: messages.stream,
    functionStream: functions.stream,
    userInitiated: true,
    responseId: 'response-id',
  });
  await audioOutput.started.await;

  return { session, rtSession: model.activeSession, handle, audioOutput, functions };
}

describe('realtime interruption cancellation', () => {
  it('cancels the response when forced speech is interrupted', async () => {
    const reply = await speakingReply();
    try {
      reply.handle.interrupt(true);
      await vi.waitFor(() => expect(reply.rtSession.interrupted).toBe(true));

      reply.functions.close();
      await reply.handle.waitForPlayout();
    } finally {
      reply.functions.close();
      await reply.session.close();
    }
  });

  it('spares a newer reply when interrupting a played-out response', async () => {
    const reply = await speakingReply();
    try {
      reply.functions.close();
      await settleStreams();

      reply.handle.interrupt(true);
      await reply.handle.waitForPlayout();

      expect(reply.handle.interrupted).toBe(true);
      expect(reply.rtSession.interrupted).toBe(false);
    } finally {
      await reply.session.close();
    }
  });

  it('spares a newer reply when interrupting a queued finished response', async () => {
    const reply = await speakingReply();
    const queued: SpeechHandle[] = [];
    reply.session.on(AgentSessionEventTypes.SpeechCreated, (event: SpeechCreatedEvent) => {
      queued.push(event.speechHandle);
    });
    try {
      reply.rtSession.emit('generation_created', emptyGeneration('response-b', false));
      await vi.waitFor(() => expect(queued).toHaveLength(1));
      await settleStreams();

      queued[0]!.interrupt(true);
      await settleStreams();

      expect(queued[0]!.interrupted).toBe(true);
      expect(reply.rtSession.interrupted).toBe(false);
    } finally {
      reply.functions.close();
      reply.audioOutput.finish();
      await reply.session.close();
    }
  });

  it('keeps the response while playout is paused', async () => {
    const reply = await speakingReply();
    try {
      reply.functions.close();
      reply.audioOutput.pause();
      await settleStreams();

      expect(reply.handle.interrupted).toBe(false);
      expect(reply.rtSession.interrupted).toBe(false);

      reply.audioOutput.resume();
      await reply.handle.waitForPlayout();
      expect(reply.rtSession.interrupted).toBe(false);
    } finally {
      await reply.session.close();
    }
  });

  it('cancels the response when interruption races the generation event', async () => {
    const model = new FakeRealtimeModel();
    const session = new AgentSession({
      llm: model,
      vad: null,
      turnHandling: { turnDetection: null },
    });
    await session.start({ agent: new Agent({ instructions: 'test' }) });
    try {
      const handle = session.generateReply();
      await vi.waitFor(() => expect(model.activeSession.replyFutures).toHaveLength(1));

      model.activeSession.replyFutures[0]!.resolve(emptyGeneration('response-id'));
      handle.interrupt(true);
      await handle.waitForPlayout();

      expect(model.activeSession.interrupted).toBe(true);
    } finally {
      await session.close();
    }
  });

  it('spares a newer reply when interrupting a finished speech with a running tool', async () => {
    const toolStarted = new Future<void>();
    const releaseTool = new Future<void>();
    const agent = new Agent({
      instructions: 'test',
      tools: {
        lookup: tool({
          description: 'Look something up.',
          execute: async () => {
            toolStarted.resolve();
            await releaseTool.await;
            return 'ok';
          },
        }),
      },
    });
    const reply = await speakingReply(agent);
    try {
      reply.functions.send(FunctionCall.create({ callId: '1', name: 'lookup', args: '{}' }));
      reply.functions.close();
      await toolStarted.await;
      reply.audioOutput.finish();

      const handleB = reply.session.generateReply();
      await vi.waitFor(() => expect(reply.rtSession.replyFutures).toHaveLength(2));
      await vi.waitFor(() => expect(reply.handle.done()).toBe(false));

      reply.handle.interrupt(true);
      await settleStreams();

      expect(reply.handle.interrupted).toBe(true);
      expect(reply.rtSession.interrupted).toBe(false);

      releaseTool.resolve();
      reply.rtSession.replyFutures[1]!.resolve(emptyGeneration('response-b'));
      await handleB.waitForPlayout();
      await reply.handle.waitForPlayout();

      expect(reply.rtSession.interrupted).toBe(false);
    } finally {
      if (!releaseTool.done) releaseTool.resolve();
      await reply.session.close();
    }
  });
});
