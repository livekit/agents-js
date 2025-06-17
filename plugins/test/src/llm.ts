// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { initializeLogger, llm as llmlib } from '@livekit/agents';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

const toolCtx: llmlib.ToolContext = {
  getWeather: llmlib.tool({
    name: 'getWeather',
    description: 'Get the current weather in a given location',
    parameters: z.object({
      location: z.string().describe('The city and state, e.g. San Francisco, CA'),
      unit: z.enum(['celsius', 'fahrenheit']).describe('The temperature unit to use'),
    }),
    execute: async () => {},
  }),
  playMusic: llmlib.tool({
    name: 'playMusic',
    description: 'Play music',
    parameters: z.object({
      name: z.string().describe('The artist and name of the song'),
    }),
    execute: async () => {},
  }),
  toggleLight: llmlib.tool({
    name: 'toggleLight',
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
    name: 'selectCurrencies',
    description: 'Currencies of a specific area',
    parameters: z.object({
      currencies: z
        .array(z.enum(['USD', 'EUR', 'GBP', 'JPY', 'SEK']))
        .describe('The currencies to select'),
    }),
    execute: async () => {},
  }),
  updateUserInfo: llmlib.tool({
    name: 'updateUserInfo',
    description: 'Update user info',
    parameters: z.object({
      email: z.string().optional().describe("User's email address"),
      name: z.string().optional().describe("User's name"),
      address: z.string().optional().describe("User's home address"),
    }),
    execute: async () => {},
  }),
  simulateFailure: llmlib.tool({
    name: 'simulateFailure',
    description: 'Simulate a failure',
    parameters: z.object({}),
    execute: async () => {
      throw new Error('Simulated failure');
    },
  }),
};

export const llm = async (llm: llmlib.LLM) => {
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
          toolCtx,
        );
        stream.executeFunctions();
        const calls = stream.functionCalls;
        const results = await Promise.all(calls.map(async (call) => {
          try {
            const tool = toolCtx[call.name];
            if (!tool) throw new Error(`Tool ${call.name} not found`);
            await tool.execute(JSON.parse(call.args), {
              ctx: {} as any,
              toolCallId: call.id,
            });
            return { task: Promise.resolve() };
          } catch (error) {
            return { task: Promise.resolve({ error }) };
          }
        }));
        stream.close();

        expect(calls.length).toStrictEqual(2);
      });
      it('should handle exceptions', async () => {
        const stream = await requestFncCall(llm, 'Call the failing function', toolCtx);
        stream.executeFunctions();
        const calls = stream.functionCalls;
        stream.close();

        expect(calls.length).toStrictEqual(1);
        const task = await (async () => {
          try {
            const tool = toolCtx[calls[0]!.name];
            if (!tool) throw new Error(`Tool ${calls[0]!.name} not found`);
            await tool.execute(JSON.parse(calls[0]!.args), {
              ctx: {} as any,
              toolCallId: calls[0]!.id,
            });
            return {};
          } catch (error) {
            return { error };
          }
        })();
        expect(task.error).toBeInstanceOf(Error);
        expect((task.error as Error).message).toStrictEqual('Simulated failure');
      });
      it('should handle arrays', async () => {
        const stream = await requestFncCall(
          llm,
          'Can you select all currencies in Europe at once from given choices?',
          toolCtx,
          0.2,
        );
        stream.executeFunctions();
        const calls = stream.functionCalls;
        stream.close();

        expect(calls.length).toStrictEqual(1);
        expect(JSON.parse(calls[0]!.args).currencies.length).toStrictEqual(3);
        expect(JSON.parse(calls[0]!.args).currencies).toContain('EUR');
        expect(JSON.parse(calls[0]!.args).currencies).toContain('GBP');
        expect(JSON.parse(calls[0]!.args).currencies).toContain('SEK');
      });
      it('should handle enums', async () => {
        const stream = await requestFncCall(
          llm,
          "What's the weather in San Francisco, in Celsius?",
          toolCtx,
        );
        stream.executeFunctions();
        const calls = stream.functionCalls;
        stream.close();

        expect(calls.length).toStrictEqual(1);
        expect(JSON.parse(calls[0]!.args).unit).toStrictEqual('celsius');
      });
      it('should handle optional arguments', async () => {
        const stream = await requestFncCall(
          llm,
          'Use a tool call to update the user info to name Theo',
          toolCtx,
        );
        stream.executeFunctions();
        const calls = stream.functionCalls;
        stream.close();

        expect(calls.length).toStrictEqual(1);
        expect(JSON.parse(calls[0]!.args).name).toStrictEqual('Theo');
        expect(JSON.parse(calls[0]!.args).email).toBeUndefined();
        expect(JSON.parse(calls[0]!.args).address).toBeUndefined();
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
    temperature,
    parallelToolCalls,
  });

  for await (const _ of stream) {
    _;
  }
  return stream;
};
