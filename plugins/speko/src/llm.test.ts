// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { llm } from '@livekit/agents';
import { describe, expect, it } from 'vitest';
import { chatContextToSpeko } from './llm.js';

describe('chatContextToSpeko', () => {
  it('merges consecutive function calls into one assistant message', () => {
    const ctx = new llm.ChatContext([
      llm.FunctionCall.create({
        callId: 'call_weather',
        name: 'get_weather',
        args: '{"location":"San Francisco"}',
        groupId: 'turn_1',
      }),
      llm.FunctionCall.create({
        callId: 'call_time',
        name: 'get_time',
        args: '{"timezone":"America/Los_Angeles"}',
        groupId: 'turn_1',
      }),
      llm.FunctionCallOutput.create({
        callId: 'call_weather',
        output: '{"temperature":72}',
        isError: false,
      }),
    ]);

    expect(chatContextToSpeko(ctx)).toEqual([
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          {
            id: 'call_weather',
            name: 'get_weather',
            args: '{"location":"San Francisco"}',
          },
          {
            id: 'call_time',
            name: 'get_time',
            args: '{"timezone":"America/Los_Angeles"}',
          },
        ],
      },
      {
        role: 'tool',
        content: '{"temperature":72}',
        toolCallId: 'call_weather',
      },
    ]);
  });
});
