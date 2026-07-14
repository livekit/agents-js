// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type * as types from '@google/genai';
import { FinishReason, FunctionCallingConfigMode, GenerateContentResponse } from '@google/genai';
import { llm } from '@livekit/agents';
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

async function* singleResponseAsyncIter(): AsyncGenerator<types.GenerateContentResponse> {
  const response = new GenerateContentResponse();
  response.candidates = [
    {
      content: { role: 'model', parts: [{ text: 'ok' }] },
      finishReason: FinishReason.STOP,
    },
  ];
  yield response;
}

async function captureConfig(
  google: LLM,
  chatOptions: Omit<Parameters<LLM['chat']>[0], 'chatCtx'> = {},
): Promise<types.GenerateContentConfig> {
  let capturedConfig: types.GenerateContentConfig | undefined;
  generateContentStreamMock.mockImplementation(
    async ({ config }: { config: types.GenerateContentConfig }) => {
      capturedConfig = config;
      return singleResponseAsyncIter();
    },
  );

  const stream = google.chat({ chatCtx: llm.ChatContext.empty(), ...chatOptions });
  await stream.collect();

  if (capturedConfig === undefined) {
    throw new Error('Google request config was not captured');
  }
  return capturedConfig;
}

function weatherTool() {
  return llm.tool({
    name: 'get_weather',
    description: 'Look up the weather.',
    execute: async () => 'ok',
  });
}

function temperatureTool() {
  return llm.tool({
    name: 'get_temperature',
    description: 'Look up the temperature.',
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

  it('preserves extraKwargs function calling config for mixed tools', async () => {
    const google = new LLM({ model: 'gemini-3-flash-preview', apiKey: 'test' });
    const functionCallingConfig = {
      mode: FunctionCallingConfigMode.ANY,
      allowedFunctionNames: ['get_weather'],
    };
    const config = await captureConfig(google, {
      toolCtx: [weatherTool(), new GoogleSearch()],
      extraKwargs: {
        toolConfig: { functionCallingConfig },
      },
    });

    expect(config.toolConfig?.functionCallingConfig).toEqual(functionCallingConfig);
    expect(serverSideEnabled(config)).toBe(true);
  });

  it.each([
    {
      toolChoice: 'required' as const,
      expectedMode: FunctionCallingConfigMode.ANY,
      expectedNames: ['get_temperature', 'get_weather'],
    },
    {
      toolChoice: 'none' as const,
      expectedMode: FunctionCallingConfigMode.NONE,
      expectedNames: undefined,
    },
  ])('maps $toolChoice tool choice', async ({ toolChoice, expectedMode, expectedNames }) => {
    const google = new LLM({ model: 'gemini-3-flash-preview', apiKey: 'test' });
    const config = await captureConfig(google, {
      toolCtx: [weatherTool(), temperatureTool()],
      toolChoice,
    });

    expect(config.toolConfig?.functionCallingConfig?.mode).toBe(expectedMode);
    expect(config.toolConfig?.functionCallingConfig?.allowedFunctionNames).toEqual(expectedNames);
  });

  it('maps a named function tool choice', async () => {
    const google = new LLM({ model: 'gemini-3-flash-preview', apiKey: 'test' });
    const config = await captureConfig(google, {
      toolCtx: [weatherTool(), temperatureTool()],
      toolChoice: {
        type: 'function',
        function: { name: 'get_weather' },
      },
    });

    expect(config.toolConfig?.functionCallingConfig).toEqual({
      mode: FunctionCallingConfigMode.ANY,
      allowedFunctionNames: ['get_weather'],
    });
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

  it('constructs identical request config on retry', async () => {
    const configs: types.GenerateContentConfig[] = [];
    generateContentStreamMock
      .mockImplementationOnce(async ({ config }: { config: types.GenerateContentConfig }) => {
        configs.push(structuredClone(config));
        throw { code: 500, message: 'retry me' };
      })
      .mockImplementationOnce(async ({ config }: { config: types.GenerateContentConfig }) => {
        configs.push(structuredClone(config));
        return singleResponseAsyncIter();
      });

    const google = new LLM({ model: 'gemini-3-flash-preview', apiKey: 'test' });
    google.on('error', () => {});
    const stream = google.chat({
      chatCtx: llm.ChatContext.empty(),
      toolCtx: [weatherTool(), new GoogleSearch()],
      toolChoice: 'auto',
      connOptions: { maxRetry: 1, retryIntervalMs: 0, timeoutMs: 1000 },
    });
    await stream.collect();

    expect(configs).toHaveLength(2);
    expect(configs[1]).toEqual(configs[0]);

    const retryConfig = configs[1];
    if (retryConfig === undefined) {
      throw new Error('Retry request config was not captured');
    }
    expect(serverSideEnabled(retryConfig)).toBe(true);
    expect(hasFunctionDeclarations(retryConfig)).toBe(true);
    expect(hasGoogleSearch(retryConfig)).toBe(true);
  });
});
