// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type * as types from '@google/genai';
import { FinishReason, ThinkingLevel } from '@google/genai';
import { llm } from '@livekit/agents';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LLM,
  type LLMOptions,
  LONG_DECODE_CONTEXT_WINDOW,
  LONG_DECODE_HTTP_TIMEOUT_MS,
  LONG_DECODE_MAX_REQUESTS,
  LONG_DECODE_MIN_OUTPUT_TOKENS,
} from './llm.js';

type LongDecodeConfig = types.GenerateContentConfig & {
  automaticContinuation?: boolean;
  continuationToken?: string;
};

const ARGON = 'gemini-4-argon';
const CONTINUATION = 'CONTINUATION' as FinishReason;

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

function google(model = ARGON, options: Partial<LLMOptions> = {}): LLM {
  return new LLM({ model, apiKey: 'test', ...options });
}

function response({
  text,
  finishReason,
  continuationToken,
  promptTokens,
  completionTokens,
  thoughtsTokens,
}: {
  text?: string;
  finishReason?: FinishReason;
  continuationToken?: string;
  promptTokens?: number;
  completionTokens?: number;
  thoughtsTokens?: number;
} = {}): types.GenerateContentResponse {
  return {
    candidates: [
      {
        content: text === undefined ? undefined : { role: 'model', parts: [{ text }] },
        finishReason,
        continuationToken,
      },
    ],
    usageMetadata:
      promptTokens === undefined && completionTokens === undefined
        ? undefined
        : {
            promptTokenCount: promptTokens,
            candidatesTokenCount: completionTokens,
            thoughtsTokenCount: thoughtsTokens,
            totalTokenCount: (promptTokens ?? 0) + (completionTokens ?? 0) + (thoughtsTokens ?? 0),
          },
  } as types.GenerateContentResponse;
}

async function* responses(
  scriptedResponses: types.GenerateContentResponse[],
): AsyncGenerator<types.GenerateContentResponse> {
  yield* scriptedResponses;
}

class FakeStreams {
  readonly configs: LongDecodeConfig[] = [];

  constructor(private readonly hops: types.GenerateContentResponse[][]) {}

  invoke = async ({ config }: { config: LongDecodeConfig }) => {
    this.configs.push(structuredClone(config));
    const index = Math.min(this.configs.length - 1, this.hops.length - 1);
    return responses(this.hops[index] ?? []);
  };
}

async function requestConfig(
  model: LLM,
  chatOptions: Omit<Parameters<LLM['chat']>[0], 'chatCtx'> = {},
): Promise<LongDecodeConfig> {
  const streams = new FakeStreams([[response({ text: 'ok', finishReason: FinishReason.STOP })]]);
  generateContentStreamMock.mockImplementation(streams.invoke);
  await model.chat({ chatCtx: llm.ChatContext.empty(), ...chatOptions }).collect();
  const config = streams.configs[0];
  if (config === undefined) {
    throw new Error('Google request config was not captured');
  }
  return config;
}

async function collect(model: LLM, streams: FakeStreams): Promise<string[]> {
  const [text] = await collectWithUsage(model, streams);
  return text;
}

async function collectWithUsage(
  model: LLM,
  streams: FakeStreams,
): Promise<[string[], llm.CompletionUsage | undefined]> {
  generateContentStreamMock.mockImplementation(streams.invoke);
  model.on('error', () => {});
  const chunks: string[] = [];
  let usage: llm.CompletionUsage | undefined;
  const stream = model.chat({ chatCtx: llm.ChatContext.empty() });
  for await (const chunk of stream) {
    if (chunk.delta?.content) {
      chunks.push(chunk.delta.content);
    }
    if (chunk.usage) {
      usage = chunk.usage;
    }
  }
  return [chunks, usage];
}

describe('Google Gemini 4 model behavior', () => {
  beforeEach(() => {
    generateContentStreamMock.mockReset();
  });

  it.each([
    ['gemini-4-argon', true],
    ['gemini-4-argon-eap', true],
    ['gemini-3-pro-preview', false],
    ['gemini-2.5-flash', false],
    ['gemma-4-27b-it', false],
  ])('detects Gemini 4 for %s', async (model, expected) => {
    const config = await requestConfig(google(model, { temperature: 0.8 }));
    expect(config.temperature === undefined).toBe(expected);
  });

  it('joins the thinking-level and thought-signature gates Gemini 3 already passed', async () => {
    const config = await requestConfig(
      google(ARGON, {
        thinkingConfig: { thinkingBudget: 1024, thinkingLevel: ThinkingLevel.HIGH },
      }),
    );
    expect(config.thinkingConfig?.thinkingBudget).toBeUndefined();
    expect(config.thinkingConfig?.thinkingLevel).toBe(ThinkingLevel.HIGH);

    generateContentStreamMock.mockResolvedValue(
      responses([
        {
          candidates: [
            {
              content: {
                role: 'model',
                parts: [
                  {
                    functionCall: { id: 'call-1', name: 'lookup', args: {} },
                    thoughtSignature: 'signature',
                  },
                ],
              },
              finishReason: FinishReason.STOP,
            },
          ],
        } as types.GenerateContentResponse,
      ]),
    );
    const result = await google().chat({ chatCtx: llm.ChatContext.empty() }).collect();
    expect(result.toolCalls[0]?.thoughtSignature).toBe('signature');
  });

  it('only drops sampling parameters for Gemini 4', async () => {
    const argon = await requestConfig(google(ARGON, { temperature: 0.8 }));
    const gemini3 = await requestConfig(google('gemini-3-pro-preview', { temperature: 0.8 }));
    expect(argon.temperature).toBeUndefined();
    expect(gemini3.temperature).toBe(0.8);
  });
});

describe('Google Gemini 4 request shaping', () => {
  beforeEach(() => {
    generateContentStreamMock.mockReset();
  });

  it('drops sampling parameters', async () => {
    const config = await requestConfig(google(ARGON, { temperature: 0.8, topP: 0.9, topK: 40 }));
    expect(config.temperature).toBeUndefined();
    expect(config.topP).toBeUndefined();
    expect(config.topK).toBeUndefined();
  });

  it('keeps sampling parameters dropped across calls', async () => {
    const model = google(ARGON, { temperature: 0.8, topP: 0.9, topK: 40 });
    for (let i = 0; i < 3; i++) {
      const config = await requestConfig(model);
      expect(config.temperature).toBeUndefined();
      expect(config.topP).toBeUndefined();
      expect(config.topK).toBeUndefined();
    }
  });

  it('preserves sampling parameters on older models', async () => {
    const config = await requestConfig(google('gemini-3-pro-preview', { temperature: 0.8 }));
    expect(config.temperature).toBe(0.8);
  });

  it('pins the output ceiling when unset', async () => {
    const config = await requestConfig(google());
    expect(config.maxOutputTokens).toBe(LONG_DECODE_MIN_OUTPUT_TOKENS);
  });

  it('leaves an explicit ceiling alone', async () => {
    const config = await requestConfig(google(ARGON, { maxOutputTokens: 256 }));
    expect(config.maxOutputTokens).toBe(256);
  });

  it('keeps the provider default for older models', async () => {
    const config = await requestConfig(google('gemini-2.5-flash'));
    expect(config.maxOutputTokens).toBeUndefined();
  });

  it('replaces a thinking budget with a level', async () => {
    const config = await requestConfig(
      google(ARGON, {
        thinkingConfig: { thinkingBudget: 1024, thinkingLevel: ThinkingLevel.HIGH },
      }),
    );
    expect(config.thinkingConfig?.thinkingBudget).toBeUndefined();
    expect(config.thinkingConfig?.thinkingLevel).toBe(ThinkingLevel.HIGH);
  });
});

describe('Google Gemini 4 long decode', () => {
  beforeEach(() => {
    generateContentStreamMock.mockReset();
  });

  it('turns off the SDK loop so the plugin can bound the turn', async () => {
    const streams = new FakeStreams([[response({ text: 'hi', finishReason: FinishReason.STOP })]]);
    await collect(google(), streams);
    expect(streams.configs[0]?.automaticContinuation).toBe(false);
  });

  it('keeps the SDK default for older models', async () => {
    const streams = new FakeStreams([[response({ text: 'hi', finishReason: FinishReason.STOP })]]);
    await collect(google('gemini-2.5-flash'), streams);
    expect(streams.configs[0]?.automaticContinuation).toBeUndefined();
  });

  it('resumes a continuation with its token', async () => {
    const streams = new FakeStreams([
      [
        response({ text: 'part one ' }),
        response({ finishReason: CONTINUATION, continuationToken: 'tok-1' }),
      ],
      [response({ text: 'part two', finishReason: FinishReason.STOP })],
    ]);
    expect(await collect(google(), streams)).toEqual(['part one ', 'part two']);
    expect(streams.configs).toHaveLength(2);
    expect(streams.configs[0]?.continuationToken).toBeUndefined();
    expect(streams.configs[1]?.continuationToken).toBe('tok-1');
    expect(streams.configs[1]?.maxOutputTokens).toBe(LONG_DECODE_MIN_OUTPUT_TOKENS);
  });

  it('caps continuation requests', async () => {
    const streams = new FakeStreams([
      [response({ text: 'x' }), response({ finishReason: CONTINUATION, continuationToken: 'tok' })],
    ]);
    await collect(google(), streams);
    expect(streams.configs).toHaveLength(LONG_DECODE_MAX_REQUESTS);
  });

  it('raises a plugin-selected ceiling to finish', async () => {
    const streams = new FakeStreams([
      [
        response({ text: 'cut off', promptTokens: 1000 }),
        response({ finishReason: FinishReason.MAX_TOKENS, continuationToken: 'tok-1' }),
      ],
      [response({ text: ' and more', finishReason: FinishReason.STOP })],
    ]);
    expect(await collect(google(), streams)).toEqual(['cut off', ' and more']);
    expect(streams.configs[1]?.continuationToken).toBe('tok-1');
    expect(streams.configs.map((config) => config.maxOutputTokens)).toEqual([
      LONG_DECODE_MIN_OUTPUT_TOKENS,
      LONG_DECODE_MIN_OUTPUT_TOKENS * 2,
    ]);
  });

  it('does not raise a caller-selected ceiling', async () => {
    const streams = new FakeStreams([
      [
        response({ text: 'cut off', promptTokens: 1000 }),
        response({ finishReason: FinishReason.MAX_TOKENS, continuationToken: 'tok-1' }),
      ],
      [response({ text: ' and more', finishReason: FinishReason.STOP })],
    ]);
    expect(await collect(google(ARGON, { maxOutputTokens: 256 }), streams)).toEqual(['cut off']);
    expect(streams.configs.map((config) => config.maxOutputTokens)).toEqual([256]);
  });

  it('treats a ceiling from extraKwargs as caller-selected', async () => {
    const streams = new FakeStreams([
      [
        response({ text: 'cut off', promptTokens: 1000 }),
        response({ finishReason: FinishReason.MAX_TOKENS, continuationToken: 'tok-1' }),
      ],
      [response({ text: ' and more', finishReason: FinishReason.STOP })],
    ]);
    generateContentStreamMock.mockImplementation(streams.invoke);
    const model = google();
    model.on('error', () => {});
    await model
      .chat({
        chatCtx: llm.ChatContext.empty(),
        extraKwargs: { maxOutputTokens: 500 },
      })
      .collect();
    expect(streams.configs.map((config) => config.maxOutputTokens)).toEqual([500]);
  });

  it('does not raise the budget without a prompt count', async () => {
    const streams = new FakeStreams([
      [
        response({ text: 'cut off' }),
        response({ finishReason: FinishReason.MAX_TOKENS, continuationToken: 'tok-1' }),
      ],
      [response({ text: ' and more', finishReason: FinishReason.STOP })],
    ]);
    expect(await collect(google(), streams)).toEqual(['cut off']);
    expect(streams.configs).toHaveLength(1);
  });

  it('does not let the budget outgrow what the prompt leaves', async () => {
    const streams = new FakeStreams([
      [
        response({
          text: 'cut off',
          promptTokens: LONG_DECODE_CONTEXT_WINDOW - LONG_DECODE_MIN_OUTPUT_TOKENS,
        }),
        response({ finishReason: FinishReason.MAX_TOKENS, continuationToken: 'tok-1' }),
      ],
    ]);
    expect(await collect(google(), streams)).toEqual(['cut off']);
    expect(streams.configs).toHaveLength(1);
  });

  it('does not resume a token alongside another finish reason', async () => {
    const streams = new FakeStreams([
      [
        response({ text: 'done' }),
        response({ finishReason: FinishReason.STOP, continuationToken: 'tok-1' }),
      ],
    ]);
    expect(await collect(google(), streams)).toEqual(['done']);
    expect(streams.configs).toHaveLength(1);
  });

  it('never resumes older models', async () => {
    const streams = new FakeStreams([
      [
        response({ text: 'done' }),
        response({ finishReason: CONTINUATION, continuationToken: 'tok' }),
      ],
    ]);
    expect(await collect(google('gemini-2.5-flash'), streams)).toEqual(['done']);
    expect(streams.configs).toHaveLength(1);
  });

  it('extends the read timeout for a long reasoning turn', async () => {
    const streams = new FakeStreams([[response({ text: 'hi', finishReason: FinishReason.STOP })]]);
    await collect(google(), streams);
    expect(streams.configs[0]?.httpOptions?.timeout).toBe(LONG_DECODE_HTTP_TIMEOUT_MS);
  });
});

describe('Google Gemini 4 stream checkpoints', () => {
  beforeEach(() => {
    generateContentStreamMock.mockReset();
  });

  it('resumes a stream that dies after a checkpoint', async () => {
    const configs: LongDecodeConfig[] = [];
    generateContentStreamMock.mockImplementation(
      async ({ config }: { config: LongDecodeConfig }) => {
        configs.push(structuredClone(config));
        if (configs.length === 1) {
          return (async function* () {
            yield response({ text: 'first half', continuationToken: 'ckpt' });
            throw new Error('connection reset');
          })();
        }
        return responses([response({ text: ' second half', finishReason: FinishReason.STOP })]);
      },
    );
    const result = await google().chat({ chatCtx: llm.ChatContext.empty() }).collect();
    expect(result.text).toBe('first half second half');
    expect(configs[1]?.continuationToken).toBe('ckpt');
  });

  it('resumes a stream that stops after a checkpoint', async () => {
    const configs: LongDecodeConfig[] = [];
    generateContentStreamMock.mockImplementation(
      async ({ config }: { config: LongDecodeConfig }) => {
        configs.push(structuredClone(config));
        if (configs.length === 1) {
          return responses([response({ text: 'first half', continuationToken: 'ckpt' })]);
        }
        return responses([response({ text: ' second half', finishReason: FinishReason.STOP })]);
      },
    );
    const result = await google().chat({ chatCtx: llm.ChatContext.empty() }).collect();
    expect(result.text).toBe('first half second half');
    expect(configs[1]?.continuationToken).toBe('ckpt');
  });

  it('does not replay output that arrived after the last checkpoint', async () => {
    const configs: LongDecodeConfig[] = [];
    generateContentStreamMock.mockImplementation(
      async ({ config }: { config: LongDecodeConfig }) => {
        configs.push(structuredClone(config));
        return (async function* () {
          yield response({ text: 'A', continuationToken: 'c1' });
          yield response({ text: 'B' });
          throw new Error('connection reset');
        })();
      },
    );
    const model = google();
    const error = new Promise<Error>((resolve) => {
      model.once('error', (event) => resolve(event.error));
    });
    const result = await model.chat({ chatCtx: llm.ChatContext.empty() }).collect();
    expect(result.text).toBe('AB');
    expect(configs).toHaveLength(1);
    await expect(error).resolves.toMatchObject({
      message: expect.stringContaining('connection reset'),
    });
  });

  it('does not replay output after a continuation without a fresh token', async () => {
    const streams = new FakeStreams([
      [
        response({ text: 'A', continuationToken: 'c1' }),
        response({ text: 'B', finishReason: CONTINUATION }),
      ],
      [response({ text: 'B', finishReason: FinishReason.STOP })],
    ]);
    expect(await collect(google(), streams)).toEqual(['A', 'B']);
    expect(streams.configs).toHaveLength(1);
  });

  it('resumes when the checkpoint covers everything emitted', async () => {
    const streams = new FakeStreams([
      [
        response({ text: 'A', continuationToken: 'c1' }),
        response({ text: 'B', continuationToken: 'c2' }),
        response({ finishReason: CONTINUATION }),
      ],
      [response({ text: 'C', finishReason: FinishReason.STOP })],
    ]);
    expect(await collect(google(), streams)).toEqual(['A', 'B', 'C']);
    expect(streams.configs[1]?.continuationToken).toBe('c2');
  });

  it('keeps a stream that stops with nothing to resume from', async () => {
    const streams = new FakeStreams([[response({ text: 'all there was' })]]);
    expect(await collect(google(), streams)).toEqual(['all there was']);
    expect(streams.configs).toHaveLength(1);
  });

  it('surfaces an error from a stream that dies without a checkpoint', async () => {
    generateContentStreamMock.mockResolvedValue(
      (async function* () {
        yield response({ text: 'partial' });
        throw new Error('connection reset');
      })(),
    );
    const model = google();
    const error = new Promise<Error>((resolve) => {
      model.once('error', (event) => resolve(event.error));
    });
    await model.chat({ chatCtx: llm.ChatContext.empty() }).collect();
    await expect(error).resolves.toMatchObject({
      message: expect.stringContaining('connection reset'),
    });
  });
});

describe('Google Gemini 4 usage across requests', () => {
  beforeEach(() => {
    generateContentStreamMock.mockReset();
  });

  it('reports the whole turn in the last usage chunk', async () => {
    const streams = new FakeStreams([
      [
        response({ text: 'one', promptTokens: 100, completionTokens: 1000 }),
        response({ finishReason: CONTINUATION, continuationToken: 'tok-1' }),
      ],
      [
        response({
          text: ' two',
          finishReason: FinishReason.STOP,
          promptTokens: 100,
          completionTokens: 1000,
        }),
      ],
    ]);
    const [, usage] = await collectWithUsage(google(), streams);
    expect(usage).toMatchObject({
      completionTokens: 2000,
      promptTokens: 200,
      totalTokens: 2200,
    });
  });

  it('counts thinking tokens in the completion and reports them as reasoning tokens', async () => {
    const streams = new FakeStreams([
      [
        response({
          text: 'hi',
          finishReason: FinishReason.STOP,
          promptTokens: 100,
          completionTokens: 50,
          thoughtsTokens: 300,
        }),
      ],
    ]);
    const [, usage] = await collectWithUsage(google(), streams);
    expect(usage).toMatchObject({
      promptTokens: 100,
      completionTokens: 350,
      reasoningTokens: 300,
      totalTokens: 450,
    });
  });

  it('sums thinking tokens across requests', async () => {
    const streams = new FakeStreams([
      [
        response({ text: 'one', promptTokens: 100, completionTokens: 50, thoughtsTokens: 300 }),
        response({ finishReason: CONTINUATION, continuationToken: 'tok-1' }),
      ],
      [
        response({
          text: ' two',
          finishReason: FinishReason.STOP,
          promptTokens: 100,
          completionTokens: 40,
          thoughtsTokens: 200,
        }),
      ],
    ]);
    const [, usage] = await collectWithUsage(google(), streams);
    expect(usage).toMatchObject({
      promptTokens: 200,
      completionTokens: 590,
      reasoningTokens: 500,
      totalTokens: 790,
    });
  });

  it('reports what the API returned for a single request', async () => {
    const streams = new FakeStreams([
      [
        response({
          text: 'hi',
          finishReason: FinishReason.STOP,
          promptTokens: 100,
          completionTokens: 50,
        }),
      ],
    ]);
    const [, usage] = await collectWithUsage(google(), streams);
    expect(usage).toMatchObject({ promptTokens: 100, completionTokens: 50 });
  });

  it('does not add restated counters within one request', async () => {
    const streams = new FakeStreams([
      [
        response({ text: 'a', promptTokens: 100, completionTokens: 10 }),
        response({ text: 'b', promptTokens: 100, completionTokens: 20 }),
        response({
          finishReason: FinishReason.STOP,
          promptTokens: 100,
          completionTokens: 30,
        }),
      ],
    ]);
    const [, usage] = await collectWithUsage(google(), streams);
    expect(usage).toMatchObject({ promptTokens: 100, completionTokens: 30 });
  });
});

describe('Google Gemini 4 extraKwargs', () => {
  beforeEach(() => {
    generateContentStreamMock.mockReset();
  });

  it('does not overwrite a ceiling passed through extraKwargs', async () => {
    const config = await requestConfig(google(), {
      extraKwargs: { maxOutputTokens: 500 },
    });
    expect(config.maxOutputTokens).toBe(500);
  });

  it('drops sampling parameters passed through extraKwargs', async () => {
    const config = await requestConfig(google(), {
      extraKwargs: { temperature: 0.7, topP: 0.5, topK: 10 },
    });
    expect(config.temperature).toBeUndefined();
    expect(config.topP).toBeUndefined();
    expect(config.topK).toBeUndefined();
  });

  it('cancels requests on close when extraKwargs carries its own abort signal', async () => {
    const external = new AbortController();
    let signal: AbortSignal | undefined;
    let started!: () => void;
    const requestStarted = new Promise<void>((resolve) => (started = resolve));
    generateContentStreamMock.mockImplementation(
      async ({ config }: { config: LongDecodeConfig }) => {
        signal = config.abortSignal;
        started();
        return (async function* () {
          await new Promise((resolve) => signal?.addEventListener('abort', resolve));
        })();
      },
    );
    const stream = google().chat({
      chatCtx: llm.ChatContext.empty(),
      extraKwargs: { abortSignal: external.signal },
    });
    await requestStarted;
    expect(signal?.aborted).toBe(false);
    stream.close();
    expect(signal?.aborted).toBe(true);
    expect(external.signal.aborted).toBe(false);
  });

  it('cancels requests when the abort signal from extraKwargs fires', async () => {
    const external = new AbortController();
    const seen: boolean[] = [];
    generateContentStreamMock.mockImplementation(
      async ({ config }: { config: LongDecodeConfig }) => {
        seen.push(config.abortSignal?.aborted ?? false);
        external.abort();
        seen.push(config.abortSignal?.aborted ?? false);
        return responses([response({ text: 'ok', finishReason: FinishReason.STOP })]);
      },
    );
    await google()
      .chat({ chatCtx: llm.ChatContext.empty(), extraKwargs: { abortSignal: external.signal } })
      .collect();
    expect(seen).toEqual([false, true]);
  });

  it('does not allow extraKwargs to hand control back to the SDK loop', async () => {
    const config = await requestConfig(google(), {
      extraKwargs: { automaticContinuation: true },
    });
    expect(config.automaticContinuation).toBe(false);
  });
});
