// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { LiveServerContent } from '@google/genai';
import { Behavior, FunctionResponseScheduling } from '@google/genai';
import { llm } from '@livekit/agents';
import { describe, expect, it, vi } from 'vitest';
import { historyConfigForSetup } from './live_setup.js';
import { RealtimeModel, RealtimeSession } from './realtime_api.js';

type ToolCallStatus = {
  name: string;
  status: 'pending' | 'continuing' | 'completed' | 'cancelled';
  willContinueSent: boolean;
  createdAt: number;
};

type RealtimeSessionInternals = {
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
  toolCallStatuses: Map<string, ToolCallStatus>;
  toolResponseCallIds: WeakMap<Record<string, unknown>, string>;
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

describe('Google Realtime initial history seeding', () => {
  function historyConfigFor(model: string) {
    const { capabilities } = new RealtimeModel({ model, apiKey: 'test-key' });
    return historyConfigForSetup({ mutableChatCtx: capabilities.midSessionChatCtxUpdate ?? true });
  }

  it('asks the server to treat the prefill as history on models that reject one', () => {
    expect(historyConfigFor('gemini-3.1-flash-live-preview')).toEqual({
      initialHistoryInClientContent: true,
    });
  });

  it('leaves models that accept a plain prefill alone', () => {
    expect(historyConfigFor('gemini-2.0-flash-live-001')).toBeUndefined();
  });
});
