// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { initializeLogger, llm as llmlib } from '@livekit/agents';
import { describe, expect, it } from 'vitest';
import { z } from 'zod/v4';

const toolCtx: llmlib.ToolContext = {
  getWeather: llmlib.tool({
    description: 'Get the current weather in a given location',
    parameters: z.object({
      location: z.string().describe('The city and state, e.g. San Francisco, CA'),
      unit: z.enum(['celsius', 'fahrenheit']).describe('The temperature unit to use'),
    }),
    execute: async () => {},
  }),
  playMusic: llmlib.tool({
    description: 'Play music',
    parameters: z.object({
      name: z.string().describe('The artist and name of the song'),
    }),
    execute: async () => {},
  }),
  toggleLight: llmlib.tool({
    description: 'Turn on/off the lights in a room',
    parameters: z.object({
      name: z.string().describe('The room to control'),
      on: z.boolean().describe('Whether to turn light on or off'),
    }),
    execute: async () => {
      await new Promise((resolve) => setTimeout(resolve, 60_000));
    },
  }),
  selectCurrencies: llmlib.tool({
    description: 'Currencies of a specific area',
    parameters: z.object({
      currencies: z
        .array(z.enum(['USD', 'EUR', 'GBP', 'JPY', 'SEK']))
        .describe('The currencies to select'),
    }),
    execute: async () => {},
  }),
  updateUserInfo: llmlib.tool({
    description: 'Update user info.',
    parameters: z.object({
      email: z.string().optional().describe("User's email address"),
      name: z.string().optional().describe("User's name"),
      address: z.string().optional().describe("User's home address"),
    }),
    execute: async () => {},
  }),
  simulateFailure: llmlib.tool({
    description: 'Simulate a failure',
    parameters: z.object({}),
    execute: async () => {
      throw new Error('Simulated failure');
    },
  }),
};

// Tool context for strict mode - uses nullable() instead of optional()
const toolCtxStrict: llmlib.ToolContext = {
  getWeather: llmlib.tool({
    description: 'Get the current weather in a given location',
    parameters: z.object({
      location: z.string().describe('The city and state, e.g. San Francisco, CA'),
      unit: z.enum(['celsius', 'fahrenheit']).describe('The temperature unit to use'),
    }),
    execute: async () => {},
  }),
  playMusic: llmlib.tool({
    description: 'Play music',
    parameters: z.object({
      name: z.string().describe('The artist and name of the song'),
    }),
    execute: async () => {},
  }),
  toggleLight: llmlib.tool({
    description: 'Turn on/off the lights in a room',
    parameters: z.object({
      name: z.string().describe('The room to control'),
      on: z.boolean().describe('Whether to turn light on or off'),
    }),
    execute: async () => {
      await new Promise((resolve) => setTimeout(resolve, 60_000));
    },
  }),
  selectCurrencies: llmlib.tool({
    description: 'Currencies of a specific area',
    parameters: z.object({
      currencies: z
        .array(z.enum(['USD', 'EUR', 'GBP', 'JPY', 'SEK']))
        .describe('The currencies to select'),
    }),
    execute: async () => {},
  }),
  updateUserInfo: llmlib.tool({
    description: 'Update user info.',
    parameters: z.object({
      email: z.string().nullable().describe("User's email address"),
      name: z.string().nullable().describe("User's name"),
      address: z.string().nullable().describe("User's home address"),
    }),
    execute: async () => {},
  }),
  simulateFailure: llmlib.tool({
    description: 'Simulate a failure',
    parameters: z.object({}),
    execute: async () => {
      throw new Error('Simulated failure');
    },
  }),
};

export const llm = async (llm: llmlib.LLM, isGoogle: boolean) => {
  initializeLogger({ pretty: false });

  describe('LLM', async () => {
    it('should properly respond to chat', async () => {
      const chatCtx = new llmlib.ChatContext();
      chatCtx.addMessage({
        role: 'system',
        content:
          'You are an assistant at a drive-thru restaurant "Live-Burger". Ask the customer what they would like to order.',
      });

      const stream = llm.chat({ chatCtx });
      let text = '';
      for await (const chunk of stream) {
        if (!chunk.delta) continue;
        text += chunk.delta.content;
      }

      expect(text.length).toBeGreaterThan(0);
    });
    describe('function calling', async () => {
      it('should handle function calling', async () => {
        const calls = await requestFncCall(
          llm,
          'Call the weather tool for Paris in celsius.',
          toolCtx,
        );

        expect(calls.length).toStrictEqual(1);
      });
      it('should handle exceptions', async () => {
        const calls = await requestFncCall(llm, 'Call the failing function', toolCtx);
        const results = await executeCalls(calls);

        expect(calls.length).toStrictEqual(1);
        expect(results[0]!.isError).toBe(true);
        expect(results[0]!.output).toContain('Simulated failure');
      });
      it('should handle arrays', async () => {
        const calls = await requestFncCall(
          llm,
          'Call the selectCurrencies function with the currencies EUR, GBP, and SEK.',
          toolCtx,
          0.2,
        );

        expect(calls.length).toStrictEqual(1);
        expect(JSON.parse(calls[0]!.args).currencies.length).toStrictEqual(3);
        expect(JSON.parse(calls[0]!.args).currencies).toContain('EUR');
        expect(JSON.parse(calls[0]!.args).currencies).toContain('GBP');
        expect(JSON.parse(calls[0]!.args).currencies).toContain('SEK');
      });
      it('should handle enums', async () => {
        const calls = await requestFncCall(
          llm,
          "What's the weather in San Francisco, in Celsius?",
          toolCtx,
        );

        expect(calls.length).toStrictEqual(1);
        expect(JSON.parse(calls[0]!.args).unit).toStrictEqual('celsius');
      });
      it.skipIf(isGoogle)('should handle optional arguments', async () => {
        const calls = await requestFncCall(
          llm,
          'Use a tool call to update the user info to name Theo. Leave email and address blank.',
          toolCtx,
        );

        expect(calls.length).toStrictEqual(1);
        expect(JSON.parse(calls[0]!.args).name).toStrictEqual('Theo');
        expect(JSON.parse(calls[0]!.args).email).toBeUndefined();
        expect(JSON.parse(calls[0]!.args).address).toBeUndefined();
      });
    });
  });
};

export const llmStrict = async (llm: llmlib.LLM) => {
  initializeLogger({ pretty: false });

  describe('LLM', async () => {
    it('should properly respond to chat', async () => {
      const chatCtx = new llmlib.ChatContext();
      chatCtx.addMessage({
        role: 'system',
        content:
          'You are an assistant at a drive-thru restaurant "Live-Burger". Ask the customer what they would like to order.',
      });

      const stream = llm.chat({ chatCtx });
      let text = '';
      for await (const chunk of stream) {
        if (!chunk.delta) continue;
        text += chunk.delta.content;
      }

      expect(text.length).toBeGreaterThan(0);
    });

    describe('function calling', async () => {
      it('should handle function calling', async () => {
        const calls = await requestFncCall(
          llm,
          'Call the weather tool for Paris in celsius.',
          toolCtxStrict,
        );

        expect(calls.length).toStrictEqual(1);
      });

      it('should handle exceptions', async () => {
        const calls = await requestFncCall(llm, 'Call the failing function', toolCtxStrict);
        const results = await executeCalls(calls);

        expect(calls.length).toStrictEqual(1);
        expect(results[0]!.isError).toBe(true);
        expect(results[0]!.output).toContain('Simulated failure');
      });

      it('should handle arrays', async () => {
        const calls = await requestFncCall(
          llm,
          'Call the selectCurrencies function with the currencies EUR, GBP, and SEK.',
          toolCtxStrict,
          0.2,
        );

        expect(calls.length).toStrictEqual(1);
        expect(JSON.parse(calls[0]!.args).currencies.length).toStrictEqual(3);
        expect(JSON.parse(calls[0]!.args).currencies).toContain('EUR');
        expect(JSON.parse(calls[0]!.args).currencies).toContain('GBP');
        expect(JSON.parse(calls[0]!.args).currencies).toContain('SEK');
      });

      it('should handle enums', async () => {
        const calls = await requestFncCall(
          llm,
          "What's the weather in San Francisco, in Celsius?",
          toolCtxStrict,
        );

        expect(calls.length).toStrictEqual(1);
        expect(JSON.parse(calls[0]!.args).unit).toStrictEqual('celsius');
      });

      it('should handle nullable arguments', async () => {
        const calls = await requestFncCall(
          llm,
          'Use a tool call to update the user info to name Theo. Leave email and address blank.',
          toolCtxStrict,
        );

        expect(calls.length).toStrictEqual(1);
        expect(JSON.parse(calls[0]!.args).name).toStrictEqual('Theo');
        expect(JSON.parse(calls[0]!.args).email).toBeNull();
        expect(JSON.parse(calls[0]!.args).address).toBeNull();
      });
    });
  });
};

const requestFncCall = async (
  llm: llmlib.LLM,
  text: string,
  toolCtx: llmlib.ToolContext,
  temperature: number | undefined = undefined,
  parallelToolCalls: boolean | undefined = undefined,
) => {
  const stream = llm.chat({
    chatCtx: new llmlib.ChatContext([
      new llmlib.ChatMessage({
        role: 'system',
        content:
          'You are an helpful assistant. Follow the instructions provided by the user. You can use multiple tool calls at once.',
      }),
      new llmlib.ChatMessage({
        role: 'user',
        content: text,
      }),
    ]),
    toolCtx,
    parallelToolCalls,
    extraKwargs: { temperature },
  });

  const calls: llmlib.FunctionCall[] = [];

  for await (const chunk of stream) {
    if (chunk.delta?.toolCalls) {
      calls.push(...chunk.delta.toolCalls);
    }
  }

  stream.close();
  return calls;
};

const executeCalls = async (calls: llmlib.FunctionCall[]) => {
  const results: llmlib.FunctionCallOutput[] = [];

  for (const call of calls) {
    const tool = toolCtx[call.name];
    if (!tool) {
      throw new Error(`Tool ${call.name} not found`);
    }

    // execute function
    const result = await llmlib.executeToolCall(call, toolCtx);
    results.push(result);
  }

  return results;
};
