// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { LiveServerContent, UsageMetadata } from '@google/genai';
import { Behavior, FunctionResponseScheduling, ThinkingLevel } from '@google/genai';
import { llm, log } from '@livekit/agents';
import { describe, expect, it, vi } from 'vitest';
import {
  RealtimeModel,
  RealtimeSession,
  replyTurns,
  toClientContentParams,
} from './realtime_api.js';

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

describe('Google Realtime instruction updates', () => {
  it.each([
    { vertexai: true, expectedRole: 'system' },
    { vertexai: false, expectedRole: 'model' },
  ] as const)(
    'uses role=$expectedRole with vertexai=$vertexai',
    async ({ vertexai, expectedRole }) => {
      const never = new Promise<void>(() => {});
      const closeActiveSession = vi
        .spyOn(
          RealtimeSession.prototype as unknown as { closeActiveSession(): Promise<void> },
          'closeActiveSession',
        )
        .mockReturnValue(never);
      const session = new RealtimeModel({
        vertexai,
        apiKey: 'fake-key',
        project: 'test-project',
        location: 'eu',
      }).session();
      closeActiveSession.mockRestore();
      const internals = session as unknown as {
        activeSession: { close(): Promise<void> };
        sendClientEvent: ReturnType<typeof vi.fn>;
      };
      internals.activeSession = { close: vi.fn(async () => {}) };
      internals.sendClientEvent = vi.fn();

      await session.updateInstructions('replacement instructions');

      expect(internals.sendClientEvent).toHaveBeenCalledWith({
        type: 'content',
        value: {
          turns: [
            {
              parts: [{ text: 'replacement instructions' }],
              role: expectedRole,
            },
          ],
          turnComplete: false,
        },
      });
      await session.close();
    },
  );
});

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

  it.each([
    { replyRequired: false, expected: FunctionResponseScheduling.SILENT },
    { replyRequired: true, expected: FunctionResponseScheduling.WHEN_IDLE },
  ])('schedules a final response from replyRequired', ({ replyRequired, expected }) => {
    const session = createSessionForTest(FunctionResponseScheduling.WHEN_IDLE);
    const ctx = llm.ChatContext.empty();
    ctx.insert(
      llm.FunctionCallOutput.create({
        callId: 'call_123',
        name: 'getWeather',
        output: 'sunny',
        isError: false,
        replyRequired,
      }),
    );

    expect(session.getToolResultsForRealtime(ctx, false)?.functionResponses[0]?.scheduling).toBe(
      expected,
    );
  });

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

    if (vertexai) {
      expect(session.sendClientEvent).not.toHaveBeenCalled();
    } else {
      expect(session.sendClientEvent).toHaveBeenCalledWith({
        type: 'tool_response',
        value: {
          functionResponses: [
            {
              id: undefined,
              name: 'getWeather',
              response: {},
              scheduling: FunctionResponseScheduling.WHEN_IDLE,
              willContinue: true,
            },
          ],
        },
      });
    }

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
        ...(vertexai
          ? {}
          : {
              scheduling: FunctionResponseScheduling.WHEN_IDLE,
              willContinue: false,
            }),
      },
    ]);
  });
});

describe('Google Realtime Vertex scheduling', () => {
  it('warns when tool response scheduling is configured for Vertex AI 2.5', () => {
    const warn = vi.spyOn(log(), 'warn').mockImplementation(() => undefined);

    new RealtimeModel({
      vertexai: true,
      project: 'p',
      location: 'us-central1',
      toolResponseScheduling: FunctionResponseScheduling.SILENT,
    });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('not supported by Vertex AI'));
    warn.mockRestore();
  });

  it('does not warn and forwards scheduling for Vertex AI gemini-3.8-live', () => {
    const warn = vi.spyOn(log(), 'warn').mockImplementation(() => undefined);

    const model = new RealtimeModel({
      model: 'gemini-3.8-live',
      vertexai: true,
      project: 'p',
      location: 'us-central1',
      toolResponseScheduling: FunctionResponseScheduling.INTERRUPT,
    });
    model.updateOptions({ toolResponseScheduling: FunctionResponseScheduling.WHEN_IDLE });

    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('not supported by Vertex AI'));
    warn.mockRestore();

    const session = createSessionForTest(FunctionResponseScheduling.WHEN_IDLE);
    (session.options as { model?: string; vertexai?: boolean }).model = 'gemini-3.8-live';
    session.options.vertexai = true;

    const ctx = llm.ChatContext.empty();
    ctx.insert(
      llm.FunctionCallOutput.create({
        callId: 'call_38',
        name: 'getWeather',
        output: 'sunny',
        isError: false,
        replyRequired: false,
      }),
    );

    expect(session.getToolResultsForRealtime(ctx, true)?.functionResponses).toEqual([
      {
        id: 'call_38',
        name: 'getWeather',
        response: { output: 'sunny' },
        scheduling: FunctionResponseScheduling.SILENT,
      },
    ]);
  });

  it('does not warn for Gemini API scheduling', () => {
    const warn = vi.spyOn(log(), 'warn').mockImplementation(() => undefined);

    new RealtimeModel({ toolResponseScheduling: FunctionResponseScheduling.SILENT });

    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('not supported by Vertex AI'));
    warn.mockRestore();
  });
});

describe('Google Realtime 3.8 defaults, labels, and contextUpdate', () => {
  it('defaults gemini-3.8-live to NON_BLOCKING and keeps realtime input open during tools', () => {
    const model38 = new RealtimeModel({
      model: 'gemini-3.8-live',
      vertexai: true,
      project: 'test-project',
      location: 'us-central1',
    });
    const model25 = new RealtimeModel({
      model: 'gemini-live-2.5-flash-native-audio',
      vertexai: true,
      project: 'test-project',
      location: 'us-central1',
    });

    expect(model38._options.toolBehavior).toBe(Behavior.NON_BLOCKING);
    expect(model25._options.toolBehavior).toBeUndefined();

    const session38 = Object.create(RealtimeSession.prototype) as {
      options: typeof model38._options;
      pendingToolCallIds: Set<string>;
      shouldBlockRealtimeInputForPendingTools(): boolean;
    };
    session38.options = model38._options;
    session38.pendingToolCallIds = new Set(['call_1']);
    expect(session38.shouldBlockRealtimeInputForPendingTools()).toBe(false);

    const session25 = Object.create(RealtimeSession.prototype) as {
      options: typeof model25._options;
      pendingToolCallIds: Set<string>;
      shouldBlockRealtimeInputForPendingTools(): boolean;
    };
    session25.options = model25._options;
    session25.pendingToolCallIds = new Set(['call_1']);
    expect(session25.shouldBlockRealtimeInputForPendingTools()).toBe(true);
  });

  it('forwards labels in buildConnectConfig when configured', () => {
    const realtimeModel = new RealtimeModel({
      model: 'gemini-3.8-live',
      vertexai: true,
      project: 'test-project',
      location: 'us-central1',
      labels: { env: 'prod', workload: 'voice-agent' },
    });
    const session = Object.create(RealtimeSession.prototype) as {
      options: typeof realtimeModel._options;
      _tools: llm.ToolContext;
      buildConnectConfig(): { labels?: Record<string, string> };
    };
    session.options = realtimeModel._options;
    session._tools = llm.ToolContext.empty();

    expect(session.buildConnectConfig().labels).toEqual({
      env: 'prod',
      workload: 'voice-agent',
    });
  });

  it('uses context_update on Vertex AI gemini-3.8-live and re-sends it on resume', async () => {
    const never = new Promise<void>(() => {});
    const closeActiveSession = vi
      .spyOn(
        RealtimeSession.prototype as unknown as { closeActiveSession(): Promise<void> },
        'closeActiveSession',
      )
      .mockReturnValue(never);
    const model = new RealtimeModel({
      model: 'gemini-3.8-live',
      vertexai: true,
      project: 'test-project',
      location: 'us-central1',
      geminiTools: { googleSearch: {} },
    });
    expect(model.capabilities.midSessionToolsUpdate).toBe(true);

    const session = model.session();
    closeActiveSession.mockRestore();

    const sentContextUpdates: unknown[] = [];
    const activeSessionMock = {
      close: vi.fn(async () => {}),
      sendContextUpdate: vi.fn((params: unknown) => {
        sentContextUpdates.push(params);
      }),
    };
    const internals = session as unknown as {
      activeSession?: typeof activeSessionMock;
      _tools: llm.ToolContext;
      contextUpdated: boolean;
      sessionResumptionHandle?: string;
      sessionShouldClose: { isSet: boolean; set(): void; clear(): void };
      markRestartNeeded(): void;
      sendTask(s: typeof activeSessionMock, controller: AbortController): Promise<void>;
      onReceiveMessage(s: typeof activeSessionMock, msg: unknown): Promise<void>;
    };

    // before a session is up, updateTools still asks for a restart
    const weatherTool = llm.tool({
      description: 'Get weather',
      execute: async () => 'sunny',
    });
    await session.updateTools(new llm.ToolContext({ getWeather: weatherTool }));
    expect(internals.sessionShouldClose.isSet).toBe(true);
    expect(internals.contextUpdated).toBe(false);
    internals.sessionShouldClose.clear();

    internals.activeSession = activeSessionMock;

    // mid-session instruction update via context_update
    await session.updateInstructions('Speak concisely.');
    expect(internals.contextUpdated).toBe(true);

    // a handle arriving after an update is still kept: it holds the spoken conversation
    await internals.onReceiveMessage(activeSessionMock, {
      sessionResumptionUpdate: { resumable: true, newHandle: 'handle-after-update' },
    });
    expect(internals.sessionResumptionHandle).toBe('handle-after-update');

    // clearing tools sends tools: { tools: [...] } preserving geminiTools
    await session.updateTools(llm.ToolContext.empty());

    // drain messageChannel through a single sendTask (mirroring #mainTask)
    const controller = new AbortController();
    const sendPromise = internals.sendTask(activeSessionMock, controller);
    await vi.waitFor(() => expect(sentContextUpdates).toHaveLength(2));

    expect(sentContextUpdates[0]).toEqual({
      systemInstruction: { parts: [{ text: 'Speak concisely.' }] },
    });
    expect(sentContextUpdates[1]).toEqual({
      tools: { tools: [{ googleSearch: {} }] },
    });

    // without geminiTools, clearing tools sends { tools: { tools: [] } }
    (session as unknown as { options: { geminiTools?: unknown } }).options.geminiTools = undefined;
    await session.updateTools(new llm.ToolContext({ getWeather: weatherTool }));
    await session.updateTools(llm.ToolContext.empty());
    await vi.waitFor(() => expect(sentContextUpdates).toHaveLength(4));
    expect(sentContextUpdates[3]).toEqual({
      tools: { tools: [] },
    });

    // a tool set that fails conversion is not committed, so the same set can be retried
    const badTool = llm.tool({
      description: 'bad',
      parameters: {
        type: 'object',
        properties: { a: { type: 'string', minLength: 'many' } },
      } as never,
      execute: async () => 'never',
    });
    const badTools = new llm.ToolContext({ bad: badTool });
    await expect(session.updateTools(badTools)).rejects.toThrow(
      'tool bad has a schema Gemini rejected',
    );
    expect(internals._tools.equals(badTools)).toBe(false);
    expect(sentContextUpdates).toHaveLength(4);

    // a config-change restart on this model keeps the handle
    internals.markRestartNeeded();
    expect(internals.sessionResumptionHandle).toBe('handle-after-update');

    controller.abort();
    await sendPromise;
    await session.close();
  });

  it('re-sends the current instructions and tools when resuming after a context update', async () => {
    const model = new RealtimeModel({
      model: 'gemini-3.8-live',
      vertexai: true,
      project: 'test-project',
      location: 'us-central1',
      instructions: 'Be brief.',
    });
    const sendContextUpdate = vi.fn();
    const sendClientContent = vi.fn();
    const session = Object.create(RealtimeSession.prototype) as {
      options: typeof model._options;
      _tools: llm.ToolContext;
      _chatCtx: llm.ChatContext;
      contextUpdated: boolean;
      sessionResumptionHandle?: string;
      sessionLock: { lock(): Promise<() => void> };
      activeSession?: unknown;
      onSessionOpened(s: unknown): Promise<void>;
    };
    session.options = model._options;
    session._tools = new llm.ToolContext({
      getWeather: llm.tool({ description: 'Get weather', execute: async () => 'sunny' }),
    });
    session._chatCtx = llm.ChatContext.empty();
    session.sessionLock = { lock: async () => () => {} };

    // no update happened: nothing is re-sent
    session.contextUpdated = false;
    session.sessionResumptionHandle = 'h1';
    await session.onSessionOpened({ sendContextUpdate, sendClientContent });
    expect(sendContextUpdate).not.toHaveBeenCalled();

    // an update happened and a handle is being resumed: current instructions and tools go first
    session.contextUpdated = true;
    await session.onSessionOpened({ sendContextUpdate, sendClientContent });
    expect(sendContextUpdate).toHaveBeenCalledTimes(1);
    const sent = sendContextUpdate.mock.calls[0]![0] as {
      systemInstruction: { parts: { text: string }[] };
      tools: { tools: { functionDeclarations?: { name: string }[] }[] };
    };
    expect(sent.systemInstruction.parts[0]!.text).toBe('Be brief.');
    expect(sent.tools.tools[0]!.functionDeclarations![0]!.name).toBe('getWeather');

    // cleared instructions are re-sent as an empty instruction, not dropped
    session.options.instructions = '';
    await session.onSessionOpened({ sendContextUpdate, sendClientContent });
    expect(sendContextUpdate).toHaveBeenCalledTimes(2);
    const cleared = sendContextUpdate.mock.calls[1]![0] as {
      systemInstruction?: { parts: { text: string }[] };
    };
    expect(cleared.systemInstruction?.parts[0]!.text).toBe('');

    // a fresh connection (no handle) carries them in the setup message instead
    session.sessionResumptionHandle = undefined;
    await session.onSessionOpened({ sendContextUpdate, sendClientContent });
    expect(sendContextUpdate).toHaveBeenCalledTimes(2);
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

describe('Google Realtime reply instructions', () => {
  // Without the placeholder, a trailing model turn is continued rather than answered, and
  // an unwrapped user turn is later recalled as something the user said.
  it.each([
    ['gemini-3.8-live', [['user', '<instructions>\nGreet the guest.\n</instructions>']]],
    [
      'gemini-3.1-flash-live-preview',
      [['user', '<instructions>\nGreet the guest.\n</instructions>']],
    ],
    [
      'gemini-2.5-flash-native-audio-preview-12-2025',
      [
        ['model', 'Greet the guest.'],
        ['user', '.'],
      ],
    ],
  ])('%s', (model, expected) => {
    const turns = replyTurns(model, 'Greet the guest.');
    expect(turns.map((t) => [t.role, t.parts?.[0]?.text])).toEqual(expected);
  });

  it('sends no instruction turn when none are given', () => {
    expect(replyTurns('gemini-3.8-live')).toEqual([]);
    expect(replyTurns('gemini-2.5-flash-native-audio-preview-12-2025')).toEqual([
      { parts: [{ text: '.' }], role: 'user' },
    ]);
  });
});
