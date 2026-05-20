// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { initializeLogger } from '@livekit/agents';
import { llm, llmStrict } from '@livekit/agents-plugins-test';
import { describe, expect, it } from 'vitest';
import { LLM } from '../responses/llm.js';
import { buildResponsesWsUrl } from './llm.js';

initializeLogger({ level: 'silent', pretty: false });

const hasOpenAIApiKey = Boolean(process.env.OPENAI_API_KEY);

describe('buildResponsesWsUrl', () => {
  it('points at the OpenAI Responses WS endpoint with model when no baseURL is set', () => {
    const url = new URL(buildResponsesWsUrl(undefined, 'gpt-4.1'));

    expect(url.protocol).toBe('wss:');
    expect(url.host).toBe('api.openai.com');
    expect(url.pathname).toBe('/v1/responses');
    expect(url.searchParams.get('model')).toBe('gpt-4.1');
  });

  it('rewrites https baseURL to wss and appends /responses with the model', () => {
    const url = new URL(buildResponsesWsUrl('https://gateway.example.com/v1', 'gpt-4o'));

    expect(url.protocol).toBe('wss:');
    expect(url.host).toBe('gateway.example.com');
    expect(url.pathname).toBe('/v1/responses');
    expect(url.searchParams.get('model')).toBe('gpt-4o');
  });

  it('strips a trailing slash on baseURL before appending /responses', () => {
    const url = new URL(buildResponsesWsUrl('https://gateway.example.com/v1/', 'gpt-4o-mini'));

    expect(url.pathname).toBe('/v1/responses');
    expect(url.searchParams.get('model')).toBe('gpt-4o-mini');
  });

  it('rewrites http baseURL to ws (not wss)', () => {
    const url = new URL(buildResponsesWsUrl('http://gateway.example.com/v1', 'gpt-4o-mini'));

    expect(url.protocol).toBe('ws:');
    expect(url.host).toBe('gateway.example.com');
    expect(url.pathname).toBe('/v1/responses');
    expect(url.searchParams.get('model')).toBe('gpt-4o-mini');
  });

  it('strips a trailing slash on an http baseURL before appending /responses', () => {
    const url = new URL(buildResponsesWsUrl('http://gateway.example.com/v1/', 'gpt-4o-mini'));

    expect(url.protocol).toBe('ws:');
    expect(url.pathname).toBe('/v1/responses');
    expect(url.searchParams.get('model')).toBe('gpt-4o-mini');
  });
});

if (hasOpenAIApiKey) {
  describe('OpenAI Responses WS wrapper', async () => {
    await llm(
      new LLM({
        temperature: 0,
        strictToolSchema: false,
        useWebSocket: true,
      }),
      true,
    );
  });

  describe('OpenAI Responses WS wrapper strict tool schema', async () => {
    await llmStrict(
      new LLM({
        temperature: 0,
        strictToolSchema: true,
        useWebSocket: true,
      }),
    );
  });
} else {
  describe('OpenAI Responses WS wrapper', () => {
    it.skip('requires OPENAI_API_KEY', () => {});
  });
}
