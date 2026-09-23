// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * What a realtime turn puts on its spans: the conversation on `realtime_inference`, the
 * caller's own input on `agent_turn`, and the caller's transcript on a `user_turn` span the
 * model's server-side turn detection would otherwise leave unrecorded.
 */
import type { AudioFrame } from '@livekit/rtc-node';
import {
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { ReadableStream } from 'node:stream/web';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ChatContext, type FunctionCall } from '../llm/chat_context.js';
import {
  type GenerationCreatedEvent,
  type MessageGeneration,
  type RealtimeCapabilities,
  RealtimeModel,
  RealtimeSession,
} from '../llm/realtime.js';
import { type ToolChoice, ToolContext, tool } from '../llm/tool_context.js';
import { initializeLogger } from '../log.js';
import { setTracerProvider, traceTypes } from '../telemetry/index.js';
import { Agent } from './agent.js';
import { AgentSession } from './agent_session.js';

initializeLogger({ pretty: false, level: 'silent' });

function setupInMemoryTracing() {
  const exporter = new InMemorySpanExporter();
  const provider = new NodeTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  provider.register();
  setTracerProvider(provider);
  return { exporter, provider };
}

function spanByName(exporter: InMemorySpanExporter, name: string): ReadableSpan {
  const spans = exporter.getFinishedSpans().filter((span) => span.name === name);
  const seen = [...new Set(exporter.getFinishedSpans().map((span) => span.name))].sort();
  expect(spans.length, `no ${name} span, got ${seen.join(', ')}`).toBeGreaterThan(0);
  return spans[0]!;
}

function jsonAttribute<T>(span: ReadableSpan, key: string): T {
  const raw = span.attributes[key];
  expect(raw, `${span.name} carries no ${key}`).toBeTypeOf('string');
  return JSON.parse(raw as string) as T;
}

function emptyStream<T>(): ReadableStream<T> {
  return new ReadableStream<T>({
    start(controller) {
      controller.close();
    },
  });
}

function oneItemStream<T>(item: T): ReadableStream<T> {
  return new ReadableStream<T>({
    start(controller) {
      controller.enqueue(item);
      controller.close();
    },
  });
}

class FakeRealtimeSession extends RealtimeSession {
  private _chatCtx = ChatContext.empty();
  private _tools = ToolContext.empty();

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

  async generateReply(): Promise<GenerationCreatedEvent> {
    const message: MessageGeneration = {
      messageId: 'message-id',
      textStream: oneItemStream('the weather today is sunny'),
      audioStream: emptyStream(),
      modalities: Promise.resolve(['text']),
    };

    return {
      messageStream: oneItemStream(message),
      functionStream: emptyStream<FunctionCall>(),
      userInitiated: true,
      responseId: 'provider-response-id',
    };
  }

  async commitAudio(): Promise<void> {}

  async clearAudio(): Promise<void> {}

  async interrupt(): Promise<void> {}

  async truncate(): Promise<void> {}
}

class FakeRealtimeModel extends RealtimeModel {
  readonly activeSession: FakeRealtimeSession;

  constructor() {
    const capabilities: RealtimeCapabilities = {
      messageTruncation: false,
      turnDetection: true,
      userTranscription: true,
      autoToolReplyGeneration: false,
      audioOutput: false,
      manualFunctionCalls: false,
      midSessionChatCtxUpdate: true,
      midSessionInstructionsUpdate: true,
      midSessionToolsUpdate: true,
      perResponseToolChoice: false,
    };
    super(capabilities);
    this.activeSession = new FakeRealtimeSession(this);
  }

  get model(): string {
    return 'fake-realtime';
  }

  session(): RealtimeSession {
    return this.activeSession;
  }

  async close(): Promise<void> {}
}

const getWeather = tool({
  description: 'Look up the weather',
  parameters: z.object({ city: z.string() }),
  execute: async () => 'sunny',
});

async function runSession(
  body: (session: AgentSession, model: FakeRealtimeModel) => Promise<void>,
): Promise<void> {
  const model = new FakeRealtimeModel();
  const session = new AgentSession({
    llm: model,
    vad: null,
    turnHandling: { turnDetection: null },
  });
  await session.start({
    agent: new Agent({ instructions: 'be concise', tools: { getWeather } }),
  });
  try {
    await body(session, model);
  } finally {
    await session.close();
  }
}

describe('realtime span content', () => {
  let provider: NodeTracerProvider | undefined;

  afterEach(async () => {
    await provider?.shutdown();
  });

  it('records the conversation the turn was built from', async () => {
    const { exporter, provider: testProvider } = setupInMemoryTracing();
    provider = testProvider;

    await runSession(async (session) => {
      await session
        .generateReply({ userInput: 'what is the weather', instructions: 'answer in one line' })
        .waitForPlayout();
    });

    const inference = spanByName(exporter, 'realtime_inference');
    // both what the session was given and what this one response asked for
    expect(
      jsonAttribute<{ content: string }[]>(
        inference,
        traceTypes.ATTR_GEN_AI_SYSTEM_INSTRUCTIONS,
      ).map((part) => part.content),
    ).toEqual(['be concise', 'answer in one line']);
    expect(
      jsonAttribute<{ role: string }[]>(inference, traceTypes.ATTR_GEN_AI_INPUT_MESSAGES).map(
        (message) => message.role,
      ),
    ).toContain('user');
    expect(jsonAttribute(inference, traceTypes.ATTR_GEN_AI_TOOL_DEFINITIONS)).toEqual([
      { type: 'function', name: 'getWeather', description: 'Look up the weather' },
    ]);

    const outputs = jsonAttribute<{ role: string; parts: unknown[]; finish_reason?: string }[]>(
      inference,
      traceTypes.ATTR_GEN_AI_OUTPUT_MESSAGES,
    );
    expect(outputs[0]!.role).toBe('assistant');
    expect(outputs[0]!.parts).toContainEqual({
      type: 'text',
      content: 'the weather today is sunny',
    });
    expect(outputs[0]!.finish_reason).toBe('stop');

    const turn = spanByName(exporter, 'agent_turn');
    expect(turn.attributes[traceTypes.ATTR_INSTRUCTIONS]).toBe('answer in one line');
    expect(turn.attributes[traceTypes.ATTR_USER_INPUT]).toBe('what is the weather');
  });

  it("opens a user_turn where the provider says the caller's turn began", async () => {
    const { exporter, provider: testProvider } = setupInMemoryTracing();
    provider = testProvider;
    const startedAt = Date.now() - 3_000;

    await runSession(async (_session, model) => {
      model.activeSession.emit('input_audio_transcription_completed', {
        itemId: 'item-1',
        transcript: 'what is the weather',
        isFinal: true,
        confidence: 0.9,
        turnStartedAt: startedAt,
      });
    });

    const turn = spanByName(exporter, 'user_turn');
    expect(turn.attributes[traceTypes.ATTR_USER_TRANSCRIPT]).toBe('what is the weather');
    expect(turn.attributes[traceTypes.ATTR_TRANSCRIPT_CONFIDENCE]).toBe(0.9);
    // back-dated to where the turn began, not to where the transcript arrived
    const startMs = turn.startTime[0] * 1_000 + turn.startTime[1] / 1_000_000;
    expect(Math.abs(startMs - startedAt)).toBeLessThan(50);
    expect(turn.attributes[traceTypes.ATTR_USER_TURN_START_ESTIMATED]).toBeUndefined();
  });

  it('marks the user_turn start as estimated when the provider reports none', async () => {
    const { exporter, provider: testProvider } = setupInMemoryTracing();
    provider = testProvider;

    await runSession(async (_session, model) => {
      model.activeSession.emit('input_audio_transcription_completed', {
        itemId: 'item-1',
        transcript: 'hello',
        isFinal: true,
      });
    });

    const turn = spanByName(exporter, 'user_turn');
    expect(turn.attributes[traceTypes.ATTR_USER_TRANSCRIPT]).toBe('hello');
    expect(turn.attributes[traceTypes.ATTR_USER_TURN_START_ESTIMATED]).toBe(true);
  });
});
