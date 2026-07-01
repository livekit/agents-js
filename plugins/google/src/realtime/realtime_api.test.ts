// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Behavior, FunctionResponseScheduling } from '@google/genai';
import { llm } from '@livekit/agents';
import { describe, expect, it, vi } from 'vitest';
import { RealtimeSession } from './realtime_api.js';

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

type SendTextSession = RealtimeSessionInternals & {
  inUserActivity: boolean;
  options: RealtimeSessionInternals['options'] & {
    realtimeInputConfig?: { automaticActivityDetection?: { disabled?: boolean } };
  };
  sendText(text: string): void;
};

function createSendTextSession(): SendTextSession {
  const session = createSessionForTest(
    FunctionResponseScheduling.WHEN_IDLE,
  ) as unknown as SendTextSession;
  session.inUserActivity = false;
  return session;
}

describe('Google Realtime sendText', () => {
  it('sends text as a single realtime_input turn', () => {
    const session = createSendTextSession();

    session.sendText('are you still there?');

    expect(session.sendClientEvent).toHaveBeenCalledTimes(1);
    expect(session.sendClientEvent).toHaveBeenCalledWith({
      type: 'realtime_input',
      value: { text: 'are you still there?' },
    });
  });

  it('does not send while blocking tools are pending', () => {
    const session = createSendTextSession();
    session.options.toolBehavior = Behavior.BLOCKING;
    session.pendingToolCallIds.add('call_123');

    session.sendText('are you still there?');

    expect(session.sendClientEvent).not.toHaveBeenCalled();
  });

  it('wraps the text in activity markers under manual activity detection', () => {
    const session = createSendTextSession();
    session.options.realtimeInputConfig = { automaticActivityDetection: { disabled: true } };

    session.sendText('are you still there?');

    expect(session.sendClientEvent).toHaveBeenNthCalledWith(1, {
      type: 'realtime_input',
      value: { activityStart: {} },
    });
    expect(session.sendClientEvent).toHaveBeenNthCalledWith(2, {
      type: 'realtime_input',
      value: { text: 'are you still there?' },
    });
    expect(session.sendClientEvent).toHaveBeenNthCalledWith(3, {
      type: 'realtime_input',
      value: { activityEnd: {} },
    });
  });
});
