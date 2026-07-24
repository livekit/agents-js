// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { llm, llmStrict } from '@livekit/agents-plugins-test';
import { describe, expect, it } from 'vitest';
import { wsServerEventSchema } from '../ws/types.js';
import { LLM } from './llm.js';

const hasOpenAIApiKey = Boolean(process.env.OPENAI_API_KEY);

describe('OpenAI Responses WebSocket', () => {
  it('preserves top-level code and param on error frames', () => {
    const frame = {
      type: 'error',
      message:
        "Invalid type for 'reasoning.mode': expected one of 'standard' or 'pro', but got null instead.",
      code: 'invalid_type',
      param: 'reasoning.mode',
      status: 400,
    };

    const parsed = wsServerEventSchema.parse(frame);

    expect(parsed.type).toBe('error');
    if (parsed.type !== 'error') throw new Error('expected error event');
    expect(parsed.message).toBe(frame.message);
    expect(parsed.param).toBe('reasoning.mode');
  });
});

if (hasOpenAIApiKey) {
  describe('OpenAI Responses', async () => {
    await llm(
      new LLM({
        temperature: 0,
        strictToolSchema: false,
      }),
      true,
    );
  });
} else {
  describe('OpenAI Responses', () => {
    it.skip('requires OPENAI_API_KEY', () => {});
  });
}

if (hasOpenAIApiKey) {
  describe('OpenAI Responses strict tool schema', async () => {
    await llmStrict(
      new LLM({
        temperature: 0,
        strictToolSchema: true,
      }),
    );
  });
} else {
  describe('OpenAI Responses strict tool schema', () => {
    it.skip('requires OPENAI_API_KEY', () => {});
  });
}
