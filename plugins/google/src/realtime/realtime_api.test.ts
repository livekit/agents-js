// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { LiveServerContent, UsageMetadata } from '@google/genai';
import { Behavior, FunctionResponseScheduling, ThinkingLevel } from '@google/genai';
import { llm, log } from '@livekit/agents';
import { describe, expect, it, vi } from 'vitest';
import { RealtimeModel, RealtimeSession, toClientContentParams } from './realtime_api.js';

const compatibleModels = [
  ['gemini-3.8-live', false],
  ['gemini-3.8-live', true],
  ['gemini-3.8-live-extended-thinking', false],
  ['gemini-3.1-flash-live-preview', false],
  ['gemini-2.5-flash-native-audio-preview-12-2025', false],
  ['gemini-live-2.5-flash-native-audio', true],
  ['models/gemini-3.8-live', false],
  ['models/gemini-3.8-live', true],
  ['google/gemini-3.8-live', true],
  ['publishers/google/models/gemini-3.8-live', true],
  ['projects/test-project/locations/eu/publishers/google/models/gemini-3.8-live', true],
  ['future-live-model', false],
  ['future-live-model', true],
  ['models/future-live-model', false],
  ['models/future-live-model', true],
  ['other/gemini-3.8-live-extended-thinking', true],
  ['publishers/other/models/gemini-3.8-live-extended-thinking', true],
  [
    'projects/test-project/locations/eu/publishers/other/models/gemini-3.8-live-extended-thinking',
    true,
  ],
] as const;

const mismatchedModels = [
  ['gemini-3.8-live-extended-thinking', true],
  ['gemini-3.1-flash-live-preview', true],
  ['gemini-2.5-flash-native-audio-preview-12-2025', true],
  ['gemini-live-2.5-flash-native-audio', false],
  ['models/gemini-3.8-live-extended-thinking', true],
  ['google/gemini-3.8-live-extended-thinking', true],
  ['publishers/google/models/gemini-3.8-live-extended-thinking', true],
  [
    'projects/test-project/locations/eu/publishers/google/models/gemini-3.8-live-extended-thinking',
    true,
  ],
  ['models/gemini-live-2.5-flash-native-audio', false],
  ['google/gemini-live-2.5-flash-native-audio', false],
  ['publishers/google/models/gemini-live-2.5-flash-native-audio', false],
  [
    'projects/test-project/locations/eu/publishers/google/models/gemini-live-2.5-flash-native-audio',
    false,
  ],
] as const;

describe('Google Realtime model API compatibility', () => {
  it.each(compatibleModels)('accepts %s with vertexai=%s', (model, vertexai) => {
    const warn = vi.spyOn(log(), 'warn').mockClear();
    const realtimeModel = new RealtimeModel({
      model,
      vertexai,
      apiKey: 'fake-key',
      project: 'test-project',
      location: 'eu',
    });

    expect(realtimeModel.model).toBe(model);
    expect(realtimeModel.provider).toBe(vertexai ? 'Vertex AI' : 'Gemini');
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it.each(mismatchedModels)('warns for %s with vertexai=%s', (model, vertexai) => {
    const warn = vi.spyOn(log(), 'warn').mockClear();
    const realtimeModel = new RealtimeModel({
      model,
      vertexai,
      apiKey: 'fake-key',
      project: 'test-project',
      location: 'eu',
    });

    expect(realtimeModel.model).toBe(model);
    expect(realtimeModel.provider).toBe(vertexai ? 'Vertex AI' : 'Gemini');
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(`Model '${model}' may not be available`),
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`vertexai=${vertexai}`));
    warn.mockRestore();
  });

  it.each([false, true])('accepts the shared model from the environment (%s)', (vertexai) => {
    vi.stubEnv('GOOGLE_GENAI_USE_VERTEXAI', String(vertexai));
    const model = new RealtimeModel({
      model: 'gemini-3.8-live',
      apiKey: 'fake-key',
      project: 'test-project',
      location: 'eu',
    });

    expect(model.provider).toBe(vertexai ? 'Vertex AI' : 'Gemini');
    vi.unstubAllEnvs();
  });
});

describe('Google Realtime thinking configuration', () => {
  it.each(['gemini-3.8-live', 'models/gemini-3.8-live'])(
    'rejects thinkingLevel for %s on the Gemini API',
    (model) => {
      vi.stubEnv('GOOGLE_GENAI_USE_VERTEXAI', 'true');

      expect(
        () =>
          new RealtimeModel({
            model,
            vertexai: false,
            apiKey: 'fake-key',
            thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          }),
      ).toThrow(/does not support thinkingLevel on the Gemini API/);
      vi.unstubAllEnvs();
    },
  );

  it.each([
    ['gemini-3.8-live', true],
    ['publishers/google/models/gemini-3.8-live', true],
    ['gemini-3.8-live-extended-thinking', false],
    ['models/gemini-3.8-live-extended-thinking', false],
    ['gemini-3.1-flash-live-preview', false],
  ] as const)('passes thinkingLevel to the connect config for %s', (model, vertexai) => {
    const thinkingConfig = { thinkingLevel: ThinkingLevel.LOW };
    const realtimeModel = new RealtimeModel({
      model,
      vertexai,
      apiKey: 'fake-key',
      project: 'test-project',
      location: 'eu',
      thinkingConfig,
    });
    const session = Object.create(RealtimeSession.prototype) as {
      options: typeof realtimeModel._options;
      _tools: llm.ToolContext;
      buildConnectConfig(): { thinkingConfig?: typeof thinkingConfig };
    };
    session.options = realtimeModel._options;
    session._tools = llm.ToolContext.empty();

    expect(session.buildConnectConfig().thinkingConfig).toBe(thinkingConfig);
  });

  it('allows an empty thinking config for gemini-3.8-live', () => {
    expect(
      () =>
        new RealtimeModel({
          model: 'gemini-3.8-live',
          vertexai: false,
          apiKey: 'fake-key',
          thinkingConfig: {},
        }),
    ).not.toThrow();
  });

  it('allows thinkingLevel with Vertex AI selected from the environment', () => {
    vi.stubEnv('GOOGLE_GENAI_USE_VERTEXAI', 'true');
    const model = new RealtimeModel({
      model: 'gemini-3.8-live',
      project: 'test-project',
      location: 'eu',
      thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
    });

    expect(model.provider).toBe('Vertex AI');
    vi.unstubAllEnvs();
  });
});

type ToolCallStatus = {
  name: string;
  status: 'pending' | 'continuing' | 'completed' | 'cancelled';
  willContinueSent: boolean;
  createdAt: number;
};

type RealtimeSessionInternals = {
  _chatCtx: llm.ChatContext;
  _realtimeModel: { capabilities: { midSessionChatCtxUpdate: boolean } };
  activeSession?: Record<string, never>;
  options: {
    toolBehavior?: Behavior;
    toolResponseScheduling?: FunctionResponseScheduling;
    vertexai?: boolean;
  };
  currentGeneration?: {
    functionChannel: {
      closed: boolean;
      write: ReturnType<typeof vi.fn>;
    };
  };
  pendingToolCallIds: Set<string>;
  syntheticCallIds: Set<string>;
  toolCallStatuses: Map<string, ToolCallStatus>;
  toolResponseCallIds: WeakMap<Record<string, unknown>, string>;
  sessionLock: { lock(): Promise<() => void> };
  pendingInterruptText: boolean;
  sendClientEvent: ReturnType<typeof vi.fn>;
  markCurrentGenerationDone: ReturnType<typeof vi.fn>;
  getToolResultsForRealtime(
    ctx: llm.ChatContext,
    vertexai: boolean,
  ): { functionResponses: Array<Record<string, unknown>> } | undefined;
  handleToolCall(toolCall: {
    functionCalls?: Array<{
      id?: string;
      name?: string;
      args?: Record<string, unknown>;
    }>;
  }): void;
  updateChatCtx(chatCtx: llm.ChatContext): Promise<void>;
};

const schedulingModes = [
  FunctionResponseScheduling.SILENT,
  FunctionResponseScheduling.WHEN_IDLE,
  FunctionResponseScheduling.INTERRUPT,
];

function createSessionForTest(
  toolResponseScheduling: FunctionResponseScheduling,
): RealtimeSessionInternals {
  const session = Object.create(RealtimeSession.prototype) as RealtimeSessionInternals;
  session.options = {
    toolBehavior: Behavior.NON_BLOCKING,
    toolResponseScheduling,
    vertexai: false,
  };
  session._chatCtx = llm.ChatContext.empty();
  session._realtimeModel = { capabilities: { midSessionChatCtxUpdate: true } };
  session.activeSession = {};
  session.pendingToolCallIds = new Set();
  session.syntheticCallIds = new Set();
  session.toolCallStatuses = new Map();
  session.toolResponseCallIds = new WeakMap();
  session.sessionLock = { lock: async () => () => {} };
  session.pendingInterruptText = false;
  session.sendClientEvent = vi.fn();
  session.markCurrentGenerationDone = vi.fn();
  session.currentGeneration = {
    functionChannel: {
      closed: false,
      write: vi.fn(),
    },
  };
  return session;
}

describe('Google Realtime non-blocking tool scheduling', () => {
  it.each(schedulingModes)(
    'sends %s on the immediate willContinue response',
    (toolResponseScheduling) => {
      const session = createSessionForTest(toolResponseScheduling);

      session.handleToolCall({
        functionCalls: [
          {
            id: 'call_123',
            name: 'getWeather',
            args: { location: 'Seattle' },
          },
        ],
      });

      expect(session.sendClientEvent).toHaveBeenCalledWith({
        type: 'tool_response',
        value: {
          functionResponses: [
            {
              id: 'call_123',
              name: 'getWeather',
              response: {},
              scheduling: toolResponseScheduling,
              willContinue: true,
            },
          ],
        },
      });
      expect(session.toolCallStatuses.get('call_123')).toMatchObject({
        name: 'getWeather',
        status: 'continuing',
        willContinueSent: true,
      });
      expect(session.pendingToolCallIds.has('call_123')).toBe(true);
    },
  );

  it.each(schedulingModes)(
    'sends %s on the final non-blocking tool response',
    (toolResponseScheduling) => {
      const session = createSessionForTest(toolResponseScheduling);
      session.toolCallStatuses.set('call_123', {
        name: 'getWeather',
        status: 'continuing',
        willContinueSent: true,
        createdAt: Date.now(),
      });

      const ctx = llm.ChatContext.empty();
      ctx.insert(
        llm.FunctionCallOutput.create({
          callId: 'call_123',
          name: 'getWeather',
          output: 'The weather in Seattle is sunny today.',
          isError: false,
        }),
      );

      const result = session.getToolResultsForRealtime(ctx, false);

      expect(result?.functionResponses).toEqual([
        {
          id: 'call_123',
          name: 'getWeather',
          response: { output: 'The weather in Seattle is sunny today.' },
          scheduling: toolResponseScheduling,
          willContinue: false,
        },
      ]);
      expect(session.toolCallStatuses.get('call_123')).toMatchObject({
        status: 'completed',
        willContinueSent: true,
      });
    },
  );

  it.each([false, true])(
    'includes the call id in outbound tool responses with vertexai=%s',
    async (vertexai) => {
      const session = createSessionForTest(FunctionResponseScheduling.WHEN_IDLE);
      session.options.vertexai = vertexai;
      session.options.toolBehavior = Behavior.BLOCKING;

      const ctx = session._chatCtx.copy();
      ctx.insert(
        llm.FunctionCallOutput.create({
          callId: 'call_123',
          name: 'getWeather',
          output: 'The weather in Seattle is sunny today.',
          isError: false,
        }),
      );

      await session.updateChatCtx(ctx);

      expect(session.sendClientEvent).toHaveBeenCalledWith({
        type: 'tool_response',
        value: {
          functionResponses: [
            {
              id: 'call_123',
              name: 'getWeather',
              response: { output: 'The weather in Seattle is sunny today.' },
              ...(vertexai ? {} : { scheduling: FunctionResponseScheduling.WHEN_IDLE }),
            },
          ],
        },
      });
    },
  );

  it.each([false, true])('includes scheduling only with vertexai=%s', (vertexai) => {
    const session = createSessionForTest(FunctionResponseScheduling.WHEN_IDLE);
    session.options.vertexai = vertexai;

    const ctx = llm.ChatContext.empty();
    ctx.insert(
      llm.FunctionCallOutput.create({
        callId: 'call_123',
        name: 'getWeather',
        output: 'The weather in Seattle is sunny today.',
        isError: false,
      }),
    );

    const response = session.getToolResultsForRealtime(ctx, vertexai)?.functionResponses[0];

    expect(response?.scheduling).toBe(vertexai ? undefined : FunctionResponseScheduling.WHEN_IDLE);
  });

  it.each([false, true])('omits synthetic ids with vertexai=%s', (vertexai) => {
    const session = createSessionForTest(FunctionResponseScheduling.WHEN_IDLE);
    session.options.vertexai = vertexai;

    session.handleToolCall({
      functionCalls: [{ name: 'getWeather', args: { location: 'Seattle' } }],
    });

    expect(session.sendClientEvent).toHaveBeenCalledWith({
      type: 'tool_response',
      value: {
        functionResponses: [
          {
            id: undefined,
            name: 'getWeather',
            response: {},
            ...(vertexai ? {} : { scheduling: FunctionResponseScheduling.WHEN_IDLE }),
            willContinue: true,
          },
        ],
      },
    });

    const callId = (
      session.currentGeneration?.functionChannel.write.mock.calls[0]?.[0] as { callId: string }
    ).callId;
    expect(callId).toBeDefined();

    const ctx = llm.ChatContext.empty();
    ctx.insert(
      llm.FunctionCallOutput.create({
        callId,
        name: 'getWeather',
        output: 'The weather in Seattle is sunny today.',
        isError: false,
      }),
    );

    expect(session.getToolResultsForRealtime(ctx, vertexai)?.functionResponses).toEqual([
      {
        id: undefined,
        name: 'getWeather',
        response: { output: 'The weather in Seattle is sunny today.' },
        ...(vertexai ? {} : { scheduling: FunctionResponseScheduling.WHEN_IDLE }),
        willContinue: false,
      },
    ]);
  });
});

type ServerContentSessionInternals = {
  _realtimeModel: { capabilities: { audioOutput: boolean } };
  options: { outputAudioTranscription?: Record<string, never> };
  earlyCompletionPending: boolean;
  currentGeneration: {
    outputText: string;
    textChannel: { write: ReturnType<typeof vi.fn> };
  };
  handleServerContent(serverContent: LiveServerContent): void;
};

function createServerContentSession({
  audioOutput,
  outputAudioTranscription,
}: {
  audioOutput: boolean;
  outputAudioTranscription?: Record<string, never>;
}): ServerContentSessionInternals {
  const session = Object.create(RealtimeSession.prototype) as ServerContentSessionInternals;
  session._realtimeModel = { capabilities: { audioOutput } };
  session.options = { outputAudioTranscription };
  session.earlyCompletionPending = false;
  session.currentGeneration = {
    outputText: '',
    textChannel: { write: vi.fn() },
  };
  return session;
}

describe('Google Realtime model text parts', () => {
  const modelTextTurn: LiveServerContent = {
    modelTurn: { parts: [{ text: 'call:getWeather{location:Seattle' }] },
    outputTranscription: { text: 'Let me check.' },
  };

  it('keeps unspoken model text out of the transcript in an audio session', () => {
    const session = createServerContentSession({
      audioOutput: true,
      outputAudioTranscription: {},
    });

    session.handleServerContent(modelTextTurn);

    expect(session.currentGeneration.textChannel.write.mock.calls).toEqual([['Let me check.']]);
    expect(session.currentGeneration.outputText).toBe('Let me check.');
  });

  it('forwards model text when the session runs in text modality', () => {
    const session = createServerContentSession({
      audioOutput: false,
      outputAudioTranscription: {},
    });

    session.handleServerContent({ modelTurn: { parts: [{ text: 'Hello there.' }] } });

    expect(session.currentGeneration.textChannel.write.mock.calls).toEqual([['Hello there.']]);
    expect(session.currentGeneration.outputText).toBe('Hello there.');
  });

  it('forwards model text when output transcription is disabled', () => {
    const session = createServerContentSession({ audioOutput: true });

    session.handleServerContent({ modelTurn: { parts: [{ text: 'Hello there.' }] } });

    expect(session.currentGeneration.textChannel.write.mock.calls).toEqual([['Hello there.']]);
    expect(session.currentGeneration.outputText).toBe('Hello there.');
  });
});

type UsageMetadataSessionInternals = {
  currentGeneration: {
    responseId: string;
    _createdTimestamp: number;
    _firstTokenTimestamp?: number;
    _completedTimestamp?: number;
    _done: boolean;
  };
  emit: ReturnType<typeof vi.fn>;
  handleUsageMetadata(usage: UsageMetadata): void;
};

function createUsageSession(): UsageMetadataSessionInternals {
  const session = Object.create(RealtimeSession.prototype) as UsageMetadataSessionInternals;
  const createdTimestamp = Date.now() - 1000;
  session.currentGeneration = {
    responseId: 'resp_1',
    _createdTimestamp: createdTimestamp,
    _firstTokenTimestamp: createdTimestamp + 100,
    _completedTimestamp: createdTimestamp + 1000,
    _done: true,
  };
  session.emit = vi.fn();
  return session;
}

describe('Google Realtime usage metadata', () => {
  it('reports thoughtsTokenCount as reasoningTokens', () => {
    const session = createUsageSession();

    session.handleUsageMetadata({
      promptTokenCount: 397,
      responseTokenCount: 49,
      thoughtsTokenCount: 26,
      totalTokenCount: 446,
    });

    expect(session.emit).toHaveBeenCalledWith(
      'metrics_collected',
      expect.objectContaining({
        inputTokens: 397,
        outputTokens: 49,
        reasoningTokens: 26,
        totalTokens: 446,
      }),
    );
  });

  it('keeps a reported zero distinguishable from an omitted count', () => {
    const reported = createUsageSession();
    reported.handleUsageMetadata({ responseTokenCount: 10, thoughtsTokenCount: 0 });
    expect(reported.emit.mock.calls[0]![1]).toHaveProperty('reasoningTokens', 0);

    const omitted = createUsageSession();
    omitted.handleUsageMetadata({ responseTokenCount: 10 });
    expect(omitted.emit.mock.calls[0]![1].reasoningTokens).toBeUndefined();
  });
});

describe('Google Realtime client content params', () => {
  it('omits an empty turns array so the SDK sends a bare turnComplete', () => {
    // generateReply() sends no turns on models that take no placeholder user
    // turn; the SDK throws on `turns: []`, which killed the send task.
    expect(toClientContentParams({ turns: [], turnComplete: true })).toEqual({
      turnComplete: true,
    });
    expect(toClientContentParams({ turnComplete: true })).toEqual({ turnComplete: true });
  });

  it('passes non-empty turns through and defaults turnComplete to true', () => {
    const turns = [{ role: 'user', parts: [{ text: 'hi' }] }];
    expect(toClientContentParams({ turns })).toEqual({ turns, turnComplete: true });
    expect(toClientContentParams({ turns, turnComplete: false })).toEqual({
      turns,
      turnComplete: false,
    });
  });
});
