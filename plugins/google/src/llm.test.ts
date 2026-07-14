// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type * as types from '@google/genai';
import { FunctionCallingConfigMode } from '@google/genai';
import { llm as agentsLlm } from '@livekit/agents';
import { llm as testLlm } from '@livekit/agents-plugins-test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LLM } from './llm.js';
import { GoogleSearch } from './tools.js';

const { generateContentStreamMock } = vi.hoisted(() => ({
  generateContentStreamMock: vi.fn(),
}));

vi.mock('@google/genai', async (importOriginal) => {
  const actual = await importOriginal();
  return Object.assign({}, actual, {
    GoogleGenAI: vi.fn(function GoogleGenAI() {
      return {
        models: {
          generateContentStream: generateContentStreamMock,
        },
      };
    }),
  });
});

const hasGoogleApiKey = Boolean(process.env.GOOGLE_API_KEY);

async function* singleResponseAsyncIter(): AsyncGenerator<types.GenerateContentResponse> {
  yield {
    candidates: [
      {
        content: { role: 'model', parts: [{ text: 'ok' }] },
        finishReason: 'STOP',
      },
    ],
  } as types.GenerateContentResponse;
}

async function captureConfig(
  llm: LLM,
  chatOptions: Omit<Parameters<LLM['chat']>[0], 'chatCtx'> = {},
): Promise<types.GenerateContentConfig> {
  let capturedConfig: types.GenerateContentConfig | undefined;
  generateContentStreamMock.mockImplementation(
    async ({ config }: { config: types.GenerateContentConfig }) => {
      capturedConfig = config;
      return singleResponseAsyncIter();
    },
  );

  const stream = llm.chat({ chatCtx: agentsLlm.ChatContext.empty(), ...chatOptions });
  await stream.collect();

  expect(capturedConfig).toBeDefined();
  return capturedConfig!;
}

function weatherTool() {
  return agentsLlm.tool({
    name: 'get_weather',
    description: 'Look up the weather.',
    execute: async () => 'ok',
  });
}

function hasGoogleSearch(config: types.GenerateContentConfig): boolean {
  return Boolean(config.tools?.some((tool) => 'googleSearch' in tool));
}

function hasFunctionDeclarations(config: types.GenerateContentConfig): boolean {
  return Boolean(config.tools?.some((tool) => 'functionDeclarations' in tool));
}

function serverSideEnabled(config: types.GenerateContentConfig): boolean {
  return Boolean(config.toolConfig?.includeServerSideToolInvocations);
}

describe('Google mixed tools request construction', () => {
  beforeEach(() => {
    generateContentStreamMock.mockReset();
  });

  it('enables server-side invocations on the Gemini 3 Developer API', async () => {
    const google = new LLM({ model: 'gemini-3-flash-preview', apiKey: 'test' });
    const config = await captureConfig(google, {
      toolCtx: [weatherTool(), new GoogleSearch()],
    });

    expect(serverSideEnabled(config)).toBe(true);
    expect(hasFunctionDeclarations(config)).toBe(true);
    expect(hasGoogleSearch(config)).toBe(true);
  });

  it('keeps auto mode for mixed tools', async () => {
    const google = new LLM({ model: 'gemini-3-flash-preview', apiKey: 'test' });
    const config = await captureConfig(google, {
      toolCtx: [weatherTool(), new GoogleSearch()],
      toolChoice: 'auto',
    });

    expect(serverSideEnabled(config)).toBe(true);
    expect(config.toolConfig?.functionCallingConfig?.mode).toBe(FunctionCallingConfigMode.AUTO);
  });

  it('drops provider tools below Gemini 3', async () => {
    const google = new LLM({ model: 'gemini-2.5-flash', apiKey: 'test' });
    const config = await captureConfig(google, {
      toolCtx: [weatherTool(), new GoogleSearch()],
    });

    expect(serverSideEnabled(config)).toBe(false);
    expect(hasFunctionDeclarations(config)).toBe(true);
    expect(hasGoogleSearch(config)).toBe(false);
  });

  it('drops provider tools for Vertex AI Gemini 3', async () => {
    const google = new LLM({
      model: 'gemini-3-flash-preview',
      vertexai: true,
      project: 'test-project',
      location: 'us-central1',
    });
    const config = await captureConfig(google, {
      toolCtx: [weatherTool(), new GoogleSearch()],
    });

    expect(serverSideEnabled(config)).toBe(false);
    expect(hasFunctionDeclarations(config)).toBe(true);
    expect(hasGoogleSearch(config)).toBe(false);
  });

  it('does not set the flag for provider tools alone', async () => {
    const google = new LLM({ model: 'gemini-3-flash-preview', apiKey: 'test' });
    const config = await captureConfig(google, { toolCtx: [new GoogleSearch()] });

    expect(serverSideEnabled(config)).toBe(false);
    expect(hasGoogleSearch(config)).toBe(true);
  });

  it('suppresses tools for cachedContent from extraKwargs', async () => {
    const google = new LLM({ model: 'gemini-3-flash-preview', apiKey: 'test' });
    const config = await captureConfig(google, {
      toolCtx: [weatherTool(), new GoogleSearch()],
      extraKwargs: { cachedContent: 'cachedContents/abc123' },
    });

    expect(config.cachedContent).toBe('cachedContents/abc123');
    expect(config.tools).toBeUndefined();
    expect(config.toolConfig).toBeUndefined();
  });

  it('strips raw tools from extraKwargs when cachedContent is active', async () => {
    const google = new LLM({
      model: 'gemini-3-flash-preview',
      apiKey: 'test',
      cachedContent: 'cachedContents/abc',
    });
    const config = await captureConfig(google, {
      extraKwargs: {
        tools: [{ googleSearch: {} }],
        toolConfig: {
          functionCallingConfig: {
            mode: FunctionCallingConfigMode.AUTO,
          },
        },
      },
    });

    expect(config.cachedContent).toBe('cachedContents/abc');
    expect(config.tools).toBeUndefined();
    expect(config.toolConfig).toBeUndefined();
  });
});

if (hasGoogleApiKey) {
  describe('Google', async () => {
    await testLlm(
      new LLM({
        model: 'gemini-2.5-flash',
        temperature: 0,
      }),
      true,
    );
  });
} else {
  describe('Google', () => {
    it.skip('requires GOOGLE_API_KEY', () => {});
  });
}
