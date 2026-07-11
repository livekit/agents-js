// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { llm, llmStrict } from '@livekit/agents-plugins-test';
import { describe, expect, it } from 'vitest';
import { ResponsesWebSocket } from '../ws/llm.js';
import { wsServerEventSchema } from '../ws/types.js';
import { LLM } from './llm.js';

const hasOpenAIApiKey = Boolean(process.env.OPENAI_API_KEY);

class RecordingWS {
  sent: string | undefined;

  readonly readyState = 1;

  on(_event: string, _listener: (...args: unknown[]) => void): this {
    return this;
  }

  send(data: string): void {
    this.sent = data;
  }

  close(): void {}
}

describe('OpenAI Responses WebSocket', () => {
  it('serializes reasoning objects without null fields', () => {
    const rawWs = new RecordingWS();
    const ws = new ResponsesWebSocket(rawWs as never);

    ws.sendRequest({
      type: 'response.create',
      model: 'gpt-5.4',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
      reasoning: { effort: 'none', mode: null },
    });

    expect(rawWs.sent).toBeDefined();
    const sent = JSON.parse(rawWs.sent!);
    expect(sent.reasoning).toEqual({ effort: 'none' });
    expect(Object.values(sent.reasoning)).not.toContain(null);
  });

  it('parses error events without sequence numbers cleanly', () => {
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
