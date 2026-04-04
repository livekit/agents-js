// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { llm } from '@livekit/agents';
import { describe, expect, it } from 'vitest';
import {
  buildGenerateReplyClientEvents,
  isRestrictedClientContentModel,
  RealtimeModel,
  supportsServerSideChatContext,
} from './realtime_api.js';
import type * as api_proto from './api_proto.js';

describe('Google realtime generateReply compatibility helpers', () => {
  it('detects restricted client-content models', () => {
    expect(isRestrictedClientContentModel('gemini-3.1-flash-live-preview')).toBe(true);
    expect(isRestrictedClientContentModel('gemini-2.5-flash-native-audio-preview-12-2025')).toBe(
      false,
    );
  });

  it('tracks whether server-side chat context syncing is supported', () => {
    expect(supportsServerSideChatContext('gemini-3.1-flash-live-preview')).toBe(false);
    expect(
      supportsServerSideChatContext('gemini-2.5-flash-native-audio-preview-12-2025'),
    ).toBe(true);
  });

  it('builds the 2.5 placeholder user turn event', () => {
    expect(
      buildGenerateReplyClientEvents({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        instructions: 'Say hello in one short sentence.',
      }),
    ).toEqual([
      {
        type: 'content',
        value: {
          turns: [
            {
              parts: [{ text: 'Say hello in one short sentence.' }],
              role: 'model',
            },
            {
              parts: [{ text: '.' }],
              role: 'user',
            },
          ],
          turnComplete: true,
        },
      },
    ]);
  });

  it('builds a 2.5 event without instructions', () => {
    expect(
      buildGenerateReplyClientEvents({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
      }),
    ).toEqual([
      {
        type: 'content',
        value: {
          turns: [
            {
              parts: [{ text: '.' }],
              role: 'user',
            },
          ],
          turnComplete: true,
        },
      },
    ]);
  });

  it('builds a Gemini 3.1 realtimeInput event with instructions', () => {
    expect(
      buildGenerateReplyClientEvents({
        model: 'gemini-3.1-flash-live-preview',
        instructions: 'Continue naturally after the tool result.',
      }),
    ).toEqual([
      {
        type: 'realtime_input',
        value: {
          text: 'Continue naturally after the tool result.',
        },
      },
    ]);
  });

  it('builds a Gemini 3.1 realtimeInput dot trigger without instructions', () => {
    expect(
      buildGenerateReplyClientEvents({
        model: 'gemini-3.1-flash-live-preview',
      }),
    ).toEqual([
      {
        type: 'realtime_input',
        value: {
          text: '.',
        },
      },
    ]);
  });

  it('prepends activityEnd when inUserActivity is true (3.1)', () => {
    expect(
      buildGenerateReplyClientEvents({
        model: 'gemini-3.1-flash-live-preview',
        instructions: 'Hello',
        inUserActivity: true,
      }),
    ).toEqual([
      {
        type: 'realtime_input',
        value: {
          activityEnd: {},
        },
      },
      {
        type: 'realtime_input',
        value: {
          text: 'Hello',
        },
      },
    ]);
  });

  it('prepends activityEnd when inUserActivity is true (2.5)', () => {
    const events = buildGenerateReplyClientEvents({
      model: 'gemini-2.5-flash-native-audio-preview-12-2025',
      inUserActivity: true,
    });
    expect(events[0]).toEqual({
      type: 'realtime_input',
      value: { activityEnd: {} },
    });
    expect(events[1]!.type).toBe('content');
  });

  it('restricted models still send tool responses from updateChatCtx', async () => {
    const session = new RealtimeModel({
      apiKey: 'test',
      model: 'gemini-3.1-flash-live-preview',
    }).session() as unknown as {
      activeSession?: unknown;
      messageChannel: {
        items: api_proto.ClientEvents[];
        put(event: api_proto.ClientEvents): Promise<void>;
      };
      updateChatCtx(chatCtx: llm.ChatContext): Promise<void>;
    };

    const events: api_proto.ClientEvents[] = [];
    Object.defineProperty(session, 'activeSession', {
      configurable: true,
      get: () => ({}),
      set: () => undefined,
    });
    session.messageChannel.put = async (event) => {
      events.push(event);
    };

    const chatCtx = llm.ChatContext.empty();
    chatCtx.insert([
      llm.ChatMessage.create({
        role: 'assistant',
        content: 'The tool finished successfully.',
      }),
      llm.FunctionCallOutput.create({
        callId: 'call_123',
        isError: false,
        name: 'lookup_weather',
        output: '{"temperature_c":21}',
      }),
    ]);

    await session.updateChatCtx(chatCtx);

    expect(events).toEqual([
      {
        type: 'tool_response',
        value: {
          functionResponses: [
            {
              id: 'call_123',
              name: 'lookup_weather',
              response: { output: '{"temperature_c":21}' },
            },
          ],
        },
      },
    ]);
  });
});
