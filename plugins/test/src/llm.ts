// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { initializeLogger, llm as llmlib } from '@livekit/agents';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

const fncCtx: llmlib.FunctionContext = {
  getWeather: {
    description: 'Get the current weather in a given location',
    parameters: z.object({
      location: z.string().describe('The city and state, e.g. San Francisco, CA'),
      unit: z.enum(['celsius', 'fahrenheit']).describe('The temperature unit to use'),
    }),
    execute: async () => {},
  },
  playMusic: {
    description: 'Play music',
    parameters: z.object({
      name: z.string().describe('The artist and name of the song'),
    }),
    execute: async () => {},
  },
  toggleLight: {
    description: 'Turn on/off the lights in a room',
    parameters: z.object({
      name: z.string().describe('The room to control'),
      on: z.boolean().describe('Whether to turn light on or off'),
    }),
    execute: async () => {
      await new Promise((resolve) => setTimeout(resolve, 60_000));
    },
  },
  selectCurrencies: {
    description: 'Currencies of a specific area',
    parameters: z.object({
      currencies: z
        .array(z.enum(['USD', 'EUR', 'GBP', 'JPY', 'SEK']))
        .describe('The currencies to select'),
    }),
    execute: async () => {},
  },
  updateUserInfo: {
    description: 'Update user info',
    parameters: z.object({
      email: z.string().optional().describe("User's email address"),
      name: z.string().optional().describe("User's name"),
      address: z.string().optional().describe("User's home address"),
    }),
    execute: async () => {},
  },
  simulateFailure: {
    description: 'Simulate a failure',
    parameters: z.object({}),
    execute: async () => {
      throw new Error('Simulated failure');
    },
  },
};

export const llm = async (llm: llmlib.LLM) => {
  initializeLogger({ pretty: false });
  describe('LLM', async () => {
    it('should properly respond to chat', async () => {
      const chatCtx = new llmlib.ChatContext().append({
        text: 'You are an assistant at a drive-thru restaurant "Live-Burger". Ask the customer what they would like to order.',
        role: llmlib.ChatRole.SYSTEM,
      });

      const stream = llm.chat({ chatCtx });
      let text = '';
      for await (const chunk of stream) {
        if (!chunk.choices.length) continue;
        text += chunk.choices[0]?.delta.content;
      }

      expect(text.length).toBeGreaterThan(0);
    });
    describe('function calling', async () => {
      it('should handle function calling', async () => {
        const stream = await requestFncCall(
          llm,
          "What's the weather in San Francisco and what's the weather in Paris?",
          fncCtx,
        );
        const calls = stream.executeFunctions();
        await Promise.all(calls.map((call) => call.task));
        stream.close();

        expect(calls.length).toStrictEqual(2);
      });
      it('should handle exceptions', async () => {
        const stream = await requestFncCall(llm, 'Call the failing function', fncCtx);
        const calls = stream.executeFunctions();
        stream.close();

        expect(calls.length).toStrictEqual(1);
        const task = await calls[0]!.task!;
        expect(task.error).toBeInstanceOf(Error);
        expect(task.error.message).toStrictEqual('Simulated failure');
      });
      it('should handle arrays', async () => {
        const stream = await requestFncCall(
          llm,
          'Can you select all currencies in Europe at once from given choices?',
          fncCtx,
          0.2,
        );
        const calls = stream.executeFunctions();
        stream.close();

        expect(calls.length).toStrictEqual(1);
        expect(calls[0]!.params.currencies.length).toStrictEqual(3);
        expect(calls[0]!.params.currencies).toContain('EUR');
        expect(calls[0]!.params.currencies).toContain('GBP');
        expect(calls[0]!.params.currencies).toContain('SEK');
      });
      it('should handle enums', async () => {
        const stream = await requestFncCall(
          llm,
          "What's the weather in San Francisco, in Celsius?",
          fncCtx,
        );
        const calls = stream.executeFunctions();
        stream.close();

        expect(calls.length).toStrictEqual(1);
        expect(calls[0]!.params.unit).toStrictEqual('celsius');
      });
      it('should handle optional arguments', async () => {
        const stream = await requestFncCall(
          llm,
          'Use a tool call to update the user info to name Theo',
          fncCtx,
        );
        const calls = stream.executeFunctions();
        stream.close();

        expect(calls.length).toStrictEqual(1);
        expect(calls[0]!.params.name).toStrictEqual('Theo');
        expect(calls[0]!.params.email).toBeUndefined();
        expect(calls[0]!.params.address).toBeUndefined();
      });
    });
  });
};

const requestFncCall = async (
  llm: llmlib.LLM,
  text: string,
  fncCtx: llmlib.FunctionContext,
  temperature: number | undefined = undefined,
  parallelToolCalls: boolean | undefined = undefined,
) => {
  const stream = llm.chat({
    chatCtx: new llmlib.ChatContext()
      .append({
        text: 'You are an helpful assistant. Follow the instructions provided by the user. You can use multiple tool calls at once.',
        role: llmlib.ChatRole.SYSTEM,
      })
      .append({ text, role: llmlib.ChatRole.USER }),
    fncCtx,
    temperature,
    parallelToolCalls,
  });

  for await (const _ of stream) {
    _;
  }
  return stream;
};
