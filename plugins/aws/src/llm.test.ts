// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { APIStatusError, llm } from '@livekit/agents';
import { llm as llmTest } from '@livekit/agents-plugins-test';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { LLM, buildToolConfig, mapConverseStreamException } from './llm.js';

const hasAwsCredentials = Boolean(process.env.AWS_ACCESS_KEY_ID || process.env.AWS_PROFILE);

// LLMStream reports terminal errors through the LLM `error` event and its background task also
// rejects during cleanup. Swallow the one deterministic failure exercised below.
const swallowExpectedFormatRejection = (reason: unknown) => {
  if (reason instanceof Error && reason.message.includes('externalUrl images are not supported')) {
    return;
  }
  throw reason;
};
beforeAll(() => process.on('unhandledRejection', swallowExpectedFormatRejection));
afterAll(() => void process.off('unhandledRejection', swallowExpectedFormatRejection));

function fakeClient(
  events: Record<string, unknown>[],
  requestId = 'req_123',
): BedrockRuntimeClient {
  return {
    send: async () => ({
      $metadata: { requestId },
      stream: (async function* () {
        yield* events;
      })(),
    }),
  } as unknown as BedrockRuntimeClient;
}

function weatherToolCtx() {
  return llm.toToolContext({
    getWeather: llm.tool({
      description: 'Get the weather for a given location.',
      parameters: z.object({ location: z.string() }),
      execute: async () => 'sunny',
    }),
  });
}

describe('AWS Bedrock LLM - buildToolConfig', () => {
  it('returns undefined when there are no tools', () => {
    expect(buildToolConfig(llm.ToolContext.empty(), undefined, false)).toBeUndefined();
  });

  it('returns undefined when toolChoice is "none"', () => {
    expect(buildToolConfig(weatherToolCtx(), 'none', false)).toBeUndefined();
  });

  it('maps toolChoice "auto" to {auto: {}}', () => {
    expect(buildToolConfig(weatherToolCtx(), 'auto', false)?.toolChoice).toEqual({ auto: {} });
  });

  it('maps toolChoice "required" to {any: {}}', () => {
    expect(buildToolConfig(weatherToolCtx(), 'required', false)?.toolChoice).toEqual({ any: {} });
  });

  it('maps a named function toolChoice to {tool: {name}}', () => {
    const config = buildToolConfig(
      weatherToolCtx(),
      { type: 'function', function: { name: 'getWeather' } },
      false,
    );
    expect(config?.toolChoice).toEqual({ tool: { name: 'getWeather' } });
  });

  it('leaves toolChoice unset when not specified', () => {
    const config = buildToolConfig(weatherToolCtx(), undefined, false);
    expect(config?.toolChoice).toBeUndefined();
    expect(config?.tools).toHaveLength(1);
  });

  it('appends a cachePoint block when cacheTools is enabled', () => {
    const config = buildToolConfig(weatherToolCtx(), 'auto', true);
    expect(config?.tools).toHaveLength(2);
    expect(config?.tools?.[1]).toEqual({ cachePoint: { type: 'default' } });
  });

  it('builds a valid toolSpec from a real ToolContext', () => {
    const config = buildToolConfig(weatherToolCtx(), 'auto', false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const toolSpec = (config?.tools?.[0] as any).toolSpec;
    expect(toolSpec.name).toBe('getWeather');
    expect(toolSpec.description).toBe('Get the weather for a given location.');
    expect(toolSpec.inputSchema.json.type).toBe('object');
    expect(Object.keys(toolSpec.inputSchema.json.properties ?? {})).toEqual(['location']);
  });

  it('omits a blank tool description', () => {
    const toolCtx = llm.toToolContext({
      noDescription: llm.tool({
        description: '   ',
        parameters: z.object({}),
        execute: async () => 'ok',
      }),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const toolSpec = (buildToolConfig(toolCtx, 'auto', false)?.tools?.[0] as any).toolSpec;

    expect(toolSpec).not.toHaveProperty('description');
  });

  it('trims a non-empty tool description', () => {
    const toolCtx = llm.toToolContext({
      paddedDescription: llm.tool({
        description: '  Useful description.  ',
        parameters: z.object({}),
        execute: async () => 'ok',
      }),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const toolSpec = (buildToolConfig(toolCtx, 'auto', false)?.tools?.[0] as any).toolSpec;

    expect(toolSpec.description).toBe('Useful description.');
  });
});

describe('AWS Bedrock LLM - constructor', () => {
  const originalEnv = process.env.BEDROCK_INFERENCE_PROFILE_ARN;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.BEDROCK_INFERENCE_PROFILE_ARN;
    } else {
      process.env.BEDROCK_INFERENCE_PROFILE_ARN = originalEnv;
    }
  });

  it('defaults the model to amazon.nova-2-lite-v1:0', () => {
    delete process.env.BEDROCK_INFERENCE_PROFILE_ARN;
    const bedrockLlm = new LLM({ client: fakeClient([]) });
    expect(bedrockLlm.model).toBe('amazon.nova-2-lite-v1:0');
  });

  it('falls back to BEDROCK_INFERENCE_PROFILE_ARN when model is not given', () => {
    process.env.BEDROCK_INFERENCE_PROFILE_ARN =
      'arn:aws:bedrock:us-east-1:123456789012:inference-profile/foo';
    const bedrockLlm = new LLM({ client: fakeClient([]) });
    expect(bedrockLlm.model).toBe('arn:aws:bedrock:us-east-1:123456789012:inference-profile/foo');
  });

  it('prefers an explicit model over BEDROCK_INFERENCE_PROFILE_ARN', () => {
    process.env.BEDROCK_INFERENCE_PROFILE_ARN =
      'arn:aws:bedrock:us-east-1:123456789012:inference-profile/foo';
    const bedrockLlm = new LLM({ model: 'anthropic.claude-3-5-sonnet', client: fakeClient([]) });
    expect(bedrockLlm.model).toBe('anthropic.claude-3-5-sonnet');
  });

  it('reports the provider label', () => {
    const bedrockLlm = new LLM({ client: fakeClient([]) });
    expect(bedrockLlm.provider).toBe('AWS Bedrock');
    expect(bedrockLlm.label()).toBe('aws.LLM');
  });
});

describe('AWS Bedrock LLM - streaming', () => {
  it('emits text deltas and usage from the Converse stream', async () => {
    const bedrockLlm = new LLM({
      client: fakeClient([
        { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'Hello' } } },
        { contentBlockDelta: { contentBlockIndex: 0, delta: { text: ' world' } } },
        { metadata: { usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } } },
      ]),
    });
    const chatCtx = new llm.ChatContext();
    chatCtx.addMessage({ role: 'user', content: 'Hi' });

    const chunks: llm.ChatChunk[] = [];
    for await (const chunk of bedrockLlm.chat({ chatCtx })) {
      chunks.push(chunk);
    }

    expect(chunks.map((c) => c.delta?.content ?? '').join('')).toBe('Hello world');
    expect(chunks.at(-1)?.usage).toEqual({
      completionTokens: 2,
      promptTokens: 5,
      totalTokens: 7,
      promptCachedTokens: 0,
    });
  });

  it('emits a FunctionCall assembled from toolUse content blocks', async () => {
    const bedrockLlm = new LLM({
      client: fakeClient([
        {
          contentBlockStart: {
            contentBlockIndex: 0,
            start: { toolUse: { toolUseId: 'call_1', name: 'getWeather' } },
          },
        },
        {
          contentBlockDelta: {
            contentBlockIndex: 0,
            delta: { toolUse: { input: '{"location":"Tokyo"}' } },
          },
        },
        { contentBlockStop: { contentBlockIndex: 0 } },
      ]),
    });
    const chatCtx = new llm.ChatContext();
    chatCtx.addMessage({ role: 'user', content: 'weather?' });

    const toolCalls: llm.FunctionCall[] = [];
    for await (const chunk of bedrockLlm.chat({ chatCtx })) {
      if (chunk.delta?.toolCalls) toolCalls.push(...chunk.delta.toolCalls);
    }

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]?.callId).toBe('call_1');
    expect(toolCalls[0]?.name).toBe('getWeather');
    expect(toolCalls[0]?.args).toBe('{"location":"Tokyo"}');
  });

  it('preserves streamed reasoning text and its signature in response extra data', async () => {
    const bedrockLlm = new LLM({
      client: fakeClient([
        {
          contentBlockDelta: {
            contentBlockIndex: 0,
            delta: { reasoningContent: { text: 'Think ' } },
          },
        },
        {
          contentBlockDelta: {
            contentBlockIndex: 0,
            delta: { reasoningContent: { text: 'carefully' } },
          },
        },
        {
          contentBlockDelta: {
            contentBlockIndex: 0,
            delta: { reasoningContent: { signature: 'signature-1' } },
          },
        },
        { contentBlockStop: { contentBlockIndex: 0 } },
        { contentBlockDelta: { contentBlockIndex: 1, delta: { text: 'Answer' } } },
      ]),
    });
    const chatCtx = new llm.ChatContext();
    chatCtx.addMessage({ role: 'user', content: 'Question' });

    const response = await bedrockLlm.chat({ chatCtx }).collect();

    expect(response.text).toBe('Answer');
    expect(response.extra).toEqual({
      aws: {
        reasoningContent: [
          { reasoningText: { text: 'Think carefully', signature: 'signature-1' } },
        ],
      },
    });
  });

  it('attaches reasoning data to a tool-only response', async () => {
    const bedrockLlm = new LLM({
      client: fakeClient([
        {
          contentBlockDelta: {
            contentBlockIndex: 0,
            delta: { reasoningContent: { text: 'Need a tool' } },
          },
        },
        {
          contentBlockDelta: {
            contentBlockIndex: 0,
            delta: { reasoningContent: { signature: 'tool-signature' } },
          },
        },
        { contentBlockStop: { contentBlockIndex: 0 } },
        {
          contentBlockStart: {
            contentBlockIndex: 1,
            start: { toolUse: { toolUseId: 'call_reasoning', name: 'getWeather' } },
          },
        },
        {
          contentBlockDelta: {
            contentBlockIndex: 1,
            delta: { toolUse: { input: '{}' } },
          },
        },
        { contentBlockStop: { contentBlockIndex: 1 } },
      ]),
    });
    const chatCtx = new llm.ChatContext();
    chatCtx.addMessage({ role: 'user', content: 'Question' });

    const response = await bedrockLlm.chat({ chatCtx }).collect();

    expect(response.toolCalls[0]?.extra).toEqual({
      aws: {
        reasoningContent: [{ reasoningText: { text: 'Need a tool', signature: 'tool-signature' } }],
      },
    });
  });

  it('omits prompt-managed request fields when model is a Prompt ARN', async () => {
    let commandInput: Record<string, unknown> | undefined;
    const client = {
      send: async (command: { input: Record<string, unknown> }) => {
        commandInput = command.input;
        return {
          $metadata: { requestId: 'req_prompt' },
          stream: (async function* () {
            yield { contentBlockDelta: { delta: { text: 'ok' } } };
          })(),
        };
      },
    } as unknown as BedrockRuntimeClient;
    const bedrockLlm = new LLM({
      model: 'arn:aws:bedrock:us-east-1:123456789012:prompt/ABCDEFGHIJ:1',
      temperature: 0.2,
      additionalRequestFields: { reasoning_config: { type: 'enabled' } },
      cacheSystem: true,
      client,
    });
    const chatCtx = new llm.ChatContext();
    chatCtx.addMessage({ role: 'system', content: 'Managed by the prompt resource' });
    chatCtx.addMessage({ role: 'user', content: 'Hi' });

    await bedrockLlm
      .chat({
        chatCtx,
        toolCtx: weatherToolCtx(),
        extraKwargs: {
          promptVariables: { topic: { text: 'weather' } },
          system: [{ text: 'must also be omitted' }],
        },
      })
      .collect();

    expect(commandInput).toMatchObject({
      modelId: 'arn:aws:bedrock:us-east-1:123456789012:prompt/ABCDEFGHIJ:1',
      promptVariables: { topic: { text: 'weather' } },
    });
    expect(commandInput).not.toHaveProperty('additionalModelRequestFields');
    expect(commandInput).not.toHaveProperty('inferenceConfig');
    expect(commandInput).not.toHaveProperty('system');
    expect(commandInput).not.toHaveProperty('toolConfig');
  });

  it('does not retry deterministic provider-format errors', async () => {
    let attempts = 0;
    const client = {
      send: async () => {
        attempts += 1;
        return { $metadata: {}, stream: (async function* () {})() };
      },
    } as unknown as BedrockRuntimeClient;
    const bedrockLlm = new LLM({ client });
    const emittedError = new Promise<Error>((resolve) => {
      bedrockLlm.once('error', ({ error }) => resolve(error));
    });
    const chatCtx = new llm.ChatContext();
    chatCtx.addMessage({
      role: 'user',
      content: [
        {
          id: 'external-image',
          type: 'image_content',
          image: 'https://example.com/image.jpg',
          inferenceDetail: 'auto',
          _cache: {},
        },
      ],
    });

    await bedrockLlm
      .chat({
        chatCtx,
        connOptions: { maxRetry: 2, retryIntervalMs: 1, timeoutMs: 1000 },
      })
      .collect();

    await expect(emittedError).resolves.toMatchObject({
      message: expect.stringMatching(/externalUrl images are not supported/),
    });
    expect(attempts).toBe(0);
  });

  it('does not apply the connection timeout to an established response stream', async () => {
    const client = {
      send: async (_command: unknown, { abortSignal }: { abortSignal: AbortSignal }) => ({
        $metadata: { requestId: 'req_slow_stream' },
        stream: (async function* () {
          await new Promise((resolve) => setTimeout(resolve, 20));
          if (abortSignal.aborted) {
            const error = new Error('stream aborted');
            error.name = 'AbortError';
            throw error;
          }
          yield { contentBlockDelta: { delta: { text: 'finished' } } };
        })(),
      }),
    } as unknown as BedrockRuntimeClient;
    const bedrockLlm = new LLM({ client });
    const chatCtx = new llm.ChatContext();
    chatCtx.addMessage({ role: 'user', content: 'Hi' });

    const chunks = [];
    for await (const chunk of bedrockLlm.chat({
      chatCtx,
      connOptions: { maxRetry: 0, retryIntervalMs: 1, timeoutMs: 5 },
    })) {
      chunks.push(chunk);
    }

    expect(chunks.map((chunk) => chunk.delta?.content ?? '').join('')).toBe('finished');
  });
});

describe('AWS Bedrock LLM - mapConverseStreamException', () => {
  it('maps validationException to a non-retryable 400 APIStatusError', () => {
    const error = mapConverseStreamException(
      { validationException: { message: 'bad input' } },
      'req_1',
      true,
    );
    expect(error).toBeInstanceOf(APIStatusError);
    expect(error?.statusCode).toBe(400);
    expect(error?.retryable).toBe(false);
    expect(error?.message).toMatch(/bad input/);
  });

  it('maps throttlingException to a 429 APIStatusError honoring the retryable flag', () => {
    const error = mapConverseStreamException(
      { throttlingException: { message: 'too many requests' } },
      'req_1',
      true,
    );
    expect(error?.statusCode).toBe(429);
    expect(error?.retryable).toBe(true);
    expect(error?.message).toMatch(/too many requests/);
  });

  it('maps internalServerException to a 500 APIStatusError', () => {
    const error = mapConverseStreamException(
      { internalServerException: { message: 'oops' } },
      'req_1',
      true,
    );
    expect(error?.statusCode).toBe(500);
    expect(error?.message).toMatch(/oops/);
  });

  it('maps modelStreamErrorException using a 5xx originalStatusCode', () => {
    const error = mapConverseStreamException(
      { modelStreamErrorException: { message: 'stream broke', originalStatusCode: 503 } },
      'req_1',
      true,
    );
    expect(error?.statusCode).toBe(503);
    expect(error?.retryable).toBe(true);
    expect(error?.message).toMatch(/stream broke/);
  });

  it('maps modelStreamErrorException with originalStatusCode 424 to a retryable 500', () => {
    // Bedrock documents model stream errors with 424; APIStatusError would otherwise force
    // non-retryable for that 4xx. Keep the configured 500 so the base LLM retry loop can recover.
    const error = mapConverseStreamException(
      { modelStreamErrorException: { message: 'stream broke', originalStatusCode: 424 } },
      'req_1',
      true,
    );
    expect(error?.statusCode).toBe(500);
    expect(error?.retryable).toBe(true);
    expect(error?.message).toMatch(/stream broke/);
  });

  it('maps serviceUnavailableException to a 503 APIStatusError', () => {
    const error = mapConverseStreamException(
      { serviceUnavailableException: { message: 'down for maintenance' } },
      'req_1',
      true,
    );
    expect(error?.statusCode).toBe(503);
    expect(error?.message).toMatch(/down for maintenance/);
  });

  it('returns undefined for a non-exception event', () => {
    expect(mapConverseStreamException({}, 'req_1', true)).toBeUndefined();
  });
});

describe('AWS Bedrock LLM - retry classification', () => {
  it('retries an HTTP 408 before output is emitted', async () => {
    let attempts = 0;
    const client = {
      send: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw Object.assign(new Error('model timed out'), {
            $metadata: { httpStatusCode: 408, requestId: 'req_timeout' },
          });
        }
        return {
          $metadata: { requestId: 'req_recovered' },
          stream: (async function* () {
            yield { contentBlockDelta: { delta: { text: 'recovered' } } };
          })(),
        };
      },
    } as unknown as BedrockRuntimeClient;
    const bedrockLlm = new LLM({ client });
    bedrockLlm.on('error', () => {});
    const chatCtx = new llm.ChatContext();
    chatCtx.addMessage({ role: 'user', content: 'Hi' });

    const chunks = [];
    for await (const chunk of bedrockLlm.chat({
      chatCtx,
      connOptions: { maxRetry: 1, retryIntervalMs: 1, timeoutMs: 1000 },
    })) {
      chunks.push(chunk);
    }

    expect(attempts).toBe(2);
    expect(chunks.map((chunk) => chunk.delta?.content ?? '').join('')).toBe('recovered');
  });
});

describe('AWS Bedrock LLM (live)', () => {
  if (hasAwsCredentials) {
    it('passes the shared LLM test harness', async () => {
      await llmTest(new LLM({ temperature: 0 }), false);
    });
  } else {
    it.skip('requires AWS_ACCESS_KEY_ID or AWS_PROFILE', () => {});
  }
});
