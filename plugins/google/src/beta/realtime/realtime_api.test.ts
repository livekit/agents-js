// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Behavior, FunctionResponseScheduling } from '@google/genai';
import { APIStatusError, llm } from '@livekit/agents';
import { describe, expect, it, vi } from 'vitest';
import { RealtimeSession } from './realtime_api.js';

type ToolCallStatus = {
  name: string;
  status: 'pending' | 'continuing' | 'completed' | 'cancelled';
  willContinueSent: boolean;
  createdAt: number;
};

type GenerationLike = {
  functionChannel: {
    closed: boolean;
    write: ReturnType<typeof vi.fn>;
  };
  outputText?: string;
  _firstTokenTimestamp?: number;
  _hadToolCall?: boolean;
  responseId?: string;
};

type RealtimeSessionInternals = {
  options: {
    toolBehavior?: Behavior;
    toolResponseScheduling?: FunctionResponseScheduling;
    vertexai?: boolean;
  };
  currentGeneration?: GenerationLike;
  generationPendingTurnComplete?: GenerationLike;
  earlyCompletionPending?: boolean;
  pendingToolCallIds: Set<string>;
  toolCallStatuses: Map<string, ToolCallStatus>;
  toolResponseCallIds: WeakMap<Record<string, unknown>, string>;
  sendClientEvent: ReturnType<typeof vi.fn>;
  markCurrentGenerationDone: ReturnType<typeof vi.fn>;
  emitError: ReturnType<typeof vi.fn>;
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
  handleServerContent(serverContent: {
    turnComplete?: boolean;
    generationComplete?: boolean;
    interrupted?: boolean;
  }): void;
  clearPendingToolCallIdsForResponses(functionResponses: Array<Record<string, unknown>>): void;
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
  session.pendingToolCallIds = new Set();
  session.toolCallStatuses = new Map();
  session.toolResponseCallIds = new WeakMap();
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

  it('clears pending tool calls for VertexAI responses without ids', () => {
    const session = createSessionForTest(FunctionResponseScheduling.WHEN_IDLE);
    session.pendingToolCallIds.add('call_123');

    const ctx = llm.ChatContext.empty();
    ctx.insert(
      llm.FunctionCallOutput.create({
        callId: 'call_123',
        name: 'getWeather',
        output: 'The weather in Seattle is sunny today.',
        isError: false,
      }),
    );

    const result = session.getToolResultsForRealtime(ctx, true);

    expect(result?.functionResponses).toEqual([
      {
        name: 'getWeather',
        response: { output: 'The weather in Seattle is sunny today.' },
        scheduling: FunctionResponseScheduling.WHEN_IDLE,
      },
    ]);

    session.clearPendingToolCallIdsForResponses(result?.functionResponses ?? []);

    expect(session.pendingToolCallIds.has('call_123')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// #1450 — Gemini realtime empty turnComplete handling
// ---------------------------------------------------------------------------

function makeGen(overrides: Partial<GenerationLike> = {}): GenerationLike {
  return {
    functionChannel: { closed: false, write: vi.fn() },
    outputText: '',
    _hadToolCall: false,
    responseId: 'GR_test',
    ...overrides,
  };
}

function createEmptyTurnSession(): RealtimeSessionInternals {
  const session = Object.create(RealtimeSession.prototype) as RealtimeSessionInternals;
  session.options = { toolBehavior: Behavior.NON_BLOCKING, vertexai: false };
  session.pendingToolCallIds = new Set();
  session.toolCallStatuses = new Map();
  session.toolResponseCallIds = new WeakMap();
  session.sendClientEvent = vi.fn();
  session.markCurrentGenerationDone = vi.fn();
  session.emitError = vi.fn();
  session.earlyCompletionPending = false;
  return session;
}

describe('Google Realtime empty turnComplete handling (#1450)', () => {
  it('emits recoverable error when turnComplete arrives with no audio, text, or tool calls', () => {
    const session = createEmptyTurnSession();
    session.currentGeneration = makeGen({ responseId: 'GR_empty' });

    session.handleServerContent({ turnComplete: true });

    expect(session.emitError).toHaveBeenCalledTimes(1);
    const [errorArg, recoverableArg] = session.emitError.mock.calls[0]!;
    expect(recoverableArg).toBe(true);
    expect(errorArg).toBeInstanceOf(APIStatusError);
    expect((errorArg as APIStatusError).message).toContain(
      'no audio, text, or tool call output',
    );
    expect((errorArg as APIStatusError).retryable).toBe(true);
    expect((errorArg as APIStatusError).requestId).toBe('GR_empty');
    expect(session.markCurrentGenerationDone).toHaveBeenCalledTimes(1);
  });

  it('does not emit error when turnComplete arrives after audio output', () => {
    const session = createEmptyTurnSession();
    session.currentGeneration = makeGen({ _firstTokenTimestamp: Date.now() });

    session.handleServerContent({ turnComplete: true });

    expect(session.emitError).not.toHaveBeenCalled();
    expect(session.markCurrentGenerationDone).toHaveBeenCalledTimes(1);
  });

  it('does not emit error when text output was emitted', () => {
    const session = createEmptyTurnSession();
    session.currentGeneration = makeGen({ outputText: 'hi' });

    session.handleServerContent({ turnComplete: true });

    expect(session.emitError).not.toHaveBeenCalled();
    expect(session.markCurrentGenerationDone).toHaveBeenCalledTimes(1);
  });

  it('does not emit error when toolCall arrived in the same LiveServerMessage', () => {
    // Catches C1: handleServerContent runs *before* handleToolCall inside
    // onReceiveMessage, so _hadToolCall must be set synchronously up-front.
    // We simulate that synchronous set here: the fix marks the flag the moment
    // onReceiveMessage sees response.toolCall, before delegating to
    // handleServerContent. Without that pre-set, the empty-turnComplete check
    // below would fire a false positive.
    const session = createEmptyTurnSession();
    const gen = makeGen({ responseId: 'GR_tool' });
    session.currentGeneration = gen;

    // Synchronous set mirroring the new code in onReceiveMessage:
    //   if (response.toolCall && this.currentGeneration) {
    //     this.currentGeneration._hadToolCall = true;
    //   }
    if (session.currentGeneration) {
      session.currentGeneration._hadToolCall = true;
    }

    session.handleServerContent({ turnComplete: true });

    expect(session.emitError).not.toHaveBeenCalled();
    expect(session.markCurrentGenerationDone).toHaveBeenCalledTimes(1);
  });

  it('checks the stashed pending generation when generationPendingTurnComplete is set', () => {
    // Catches C3: when a previous gen is stashed in generationPendingTurnComplete,
    // the next turnComplete belongs to *that* stashed gen, not the active one.
    const session = createEmptyTurnSession();
    const stashed = makeGen({
      responseId: 'GR_stashed_empty',
      outputText: '',
      _hadToolCall: false,
    });
    const active = makeGen({
      responseId: 'GR_active_with_tool',
      _hadToolCall: true,
    });
    session.generationPendingTurnComplete = stashed;
    session.currentGeneration = active;

    session.handleServerContent({ turnComplete: true });

    expect(session.emitError).toHaveBeenCalledTimes(1);
    const [errorArg] = session.emitError.mock.calls[0]!;
    expect(errorArg).toBeInstanceOf(APIStatusError);
    // requestId points at the *stashed* gen, not the active currentGeneration.
    expect((errorArg as APIStatusError).requestId).toBe('GR_stashed_empty');
  });
});
