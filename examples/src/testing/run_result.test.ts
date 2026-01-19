// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Integration test for the agent test framework (RunResult, RunAssert, EventAssert).
 * Tests all assertion methods including:
 * - Basic assertions: nextEvent(), isMessage(), isFunctionCall(), isFunctionCallOutput()
 * - Cursor navigation: at(), skipNext()
 * - Conditional skip: skipNextEventIf()
 * - Range assertions: range(), containsFunctionCall(), containsMessage()
 * - LLM-based assertions: judge()
 *
 * This test requires OPENAI_API_KEY to be set.
 *
 * Run with: pnpm vitest run run_result
 */
import { initializeLogger, llm, voice } from '@livekit/agents';
import * as openai from '@livekit/agents-plugin-openai';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

initializeLogger({ pretty: false, level: 'warn' });

const { AgentSession, Agent } = voice;

type TestableAgentSession = InstanceType<typeof AgentSession> & {
  run(options: { userInput: string }): voice.testing.RunResult;
};

/**
 * Test agent with diverse tools for comprehensive test scenarios.
 */
class TestAgent extends Agent {
  constructor() {
    super({
      instructions: `You are a helpful assistant named Max for a restaurant ordering system.
Keep responses SHORT (1-2 sentences max).
Remember user names when introduced.

Tool usage rules:
- When asked about the weather, ALWAYS use the getWeather tool first.
- When asked about the time, ALWAYS use the getCurrentTime tool.
- When asked to order food, ALWAYS use the orderItem tool.
- When asked to check order status, ALWAYS use the getOrderStatus tool.
- When asked about menu items or prices, ALWAYS use the getMenuItems tool.
- For complex orders with multiple items, call orderItem multiple times.

Response rules:
- After getting weather, describe it naturally (e.g., "It's sunny and 72°F in Tokyo").
- After ordering, confirm what was added (e.g., "I've added the burger to your order").
- When asked about sizes, always ask for clarification if not specified.
- Be friendly and proactive in suggesting next steps.`,
      tools: {
        getWeather: llm.tool({
          description: 'Get the current weather for a location',
          parameters: z.object({
            location: z.string().describe('The city name'),
          }),
          execute: async ({ location }) => {
            return JSON.stringify({
              location,
              temperature: 72,
              condition: 'sunny',
            });
          },
        }),
        getCurrentTime: llm.tool({
          description: 'Get the current time',
          parameters: z.object({}),
          execute: async () => {
            return '3:00 PM';
          },
        }),
        orderItem: llm.tool({
          description: 'Add an item to the order',
          parameters: z.object({
            itemId: z.string().describe('The menu item ID'),
            quantity: z.number().optional().describe('Quantity to order (default: 1)'),
            size: z.enum(['S', 'M', 'L']).optional().describe('Size if applicable'),
          }),
          execute: async ({ itemId, quantity = 1, size }) => {
            return JSON.stringify({
              success: true,
              orderId: `ORD-${Date.now()}`,
              item: itemId,
              quantity,
              size: size || 'M',
              message: `Added ${quantity}x ${itemId}${size ? ` (${size})` : ''} to order`,
            });
          },
        }),
        getOrderStatus: llm.tool({
          description: 'Get the current order status',
          parameters: z.object({}),
          execute: async () => {
            return JSON.stringify({
              items: [
                { name: 'Burger', quantity: 1, price: 8.99 },
                { name: 'Fries', quantity: 1, price: 3.99 },
              ],
              total: 12.98,
              status: 'pending',
            });
          },
        }),
        getMenuItems: llm.tool({
          description: 'Get available menu items and prices',
          parameters: z.object({
            category: z
              .enum(['burgers', 'sides', 'drinks', 'desserts'])
              .optional()
              .describe('Filter by category'),
          }),
          execute: async ({ category }) => {
            const menu = {
              burgers: [
                { id: 'burger', name: 'Classic Burger', price: 8.99 },
                { id: 'cheeseburger', name: 'Cheeseburger', price: 9.99 },
              ],
              sides: [
                { id: 'fries', name: 'French Fries', price: 3.99, sizes: ['S', 'M', 'L'] },
                { id: 'onion_rings', name: 'Onion Rings', price: 4.99 },
              ],
              drinks: [
                { id: 'cola', name: 'Cola', price: 2.49, sizes: ['S', 'M', 'L'] },
                { id: 'lemonade', name: 'Lemonade', price: 2.99, sizes: ['S', 'M', 'L'] },
              ],
              desserts: [{ id: 'sundae', name: 'Ice Cream Sundae', price: 4.99 }],
            };
            if (category) {
              return JSON.stringify(menu[category]);
            }
            return JSON.stringify(menu);
          },
        }),
      },
    });
  }
}

describe('RunResult', { timeout: 120_000 }, () => {
  let session: TestableAgentSession;
  let llmInstance: openai.LLM;

  beforeAll(async () => {
    llmInstance = new openai.LLM({ model: 'gpt-4o-mini', temperature: 0 });
    session = new AgentSession({ llm: llmInstance }) as TestableAgentSession;
    await session.start({ agent: new TestAgent() });
  });

  afterAll(async () => {
    await session?.close();
  });

  describe('message assertions', () => {
    it('should capture assistant message with nextEvent().isMessage()', async () => {
      const result = session.run({ userInput: 'Hello!' });
      await result.wait();

      expect(result.events.length).toBeGreaterThan(0);
      result.expect.nextEvent().isMessage({ role: 'assistant' });
      result.expect.noMoreEvents();
    });

    it('should remember context across turns', async () => {
      const r1 = session.run({ userInput: 'My name is Alice.' });
      await r1.wait();
      r1.expect.nextEvent().isMessage({ role: 'assistant' });
      r1.expect.noMoreEvents();

      const r2 = session.run({ userInput: 'What is my name?' });
      await r2.wait();
      r2.expect.nextEvent().isMessage({ role: 'assistant' });
      r2.expect.noMoreEvents();

      // Verify the agent remembered the name
      const response = r2.events[0];
      expect(response?.type).toBe('message');
      if (response?.type === 'message') {
        const content = response.item.content;
        const text = typeof content === 'string' ? content : JSON.stringify(content);
        expect(text.toLowerCase()).toContain('alice');
      }
    });
  });

  describe('function call assertions', () => {
    it('should capture tool call with isFunctionCall()', async () => {
      const result = session.run({ userInput: "What's the weather in Tokyo?" });
      await result.wait();

      expect(result.events.length).toBe(3); // function_call, function_call_output, message
      result.expect.nextEvent().isFunctionCall({ name: 'getWeather' });
      result.expect.nextEvent().isFunctionCallOutput();
      result.expect.nextEvent().isMessage({ role: 'assistant' });
      result.expect.noMoreEvents();
    });

    it('should capture getCurrentTime tool call', async () => {
      const result = session.run({ userInput: 'What time is it?' });
      await result.wait();

      result.expect.nextEvent().isFunctionCall({ name: 'getCurrentTime' });
      result.expect.nextEvent().isFunctionCallOutput();
      result.expect.nextEvent().isMessage({ role: 'assistant' });
      result.expect.noMoreEvents();
    });

    it('should verify function call arguments', async () => {
      const result = session.run({ userInput: 'Order a large cola' });
      await result.wait();

      result.expect.nextEvent().isFunctionCall({
        name: 'orderItem',
        args: { itemId: 'cola', size: 'L' },
      });
      result.expect.nextEvent().isFunctionCallOutput();
      result.expect.nextEvent().isMessage({ role: 'assistant' });
      result.expect.noMoreEvents();
    });
  });

  describe('cursor navigation', () => {
    it('should support at() for random access', async () => {
      const result = session.run({ userInput: "What's the weather in Paris?" });
      await result.wait();

      // Random access with at()
      result.expect.at(0).isFunctionCall({ name: 'getWeather' });
      result.expect.at(1).isFunctionCallOutput();
      result.expect.at(-1).isMessage({ role: 'assistant' }); // negative index
    });

    it('should support skipNext() to skip events', async () => {
      const result = session.run({ userInput: "What's the weather in London?" });
      await result.wait();

      // Skip function_call and function_call_output
      result.expect.skipNext(2);
      result.expect.nextEvent().isMessage({ role: 'assistant' });
      result.expect.noMoreEvents();
    });
  });

  describe('skipNextEventIf', () => {
    it('should skip matching message event', async () => {
      const result = session.run({ userInput: 'Hello there!' });
      await result.wait();

      // This should match and skip the assistant message
      const skipped = result.expect.skipNextEventIf({ type: 'message', role: 'assistant' });
      expect(skipped).toBeDefined();
      result.expect.noMoreEvents();
    });

    it('should return undefined when event does not match', async () => {
      const result = session.run({ userInput: "What's the weather in Miami?" });
      await result.wait();

      // First event is function_call, not message - should return undefined
      const skipped = result.expect.skipNextEventIf({ type: 'message', role: 'assistant' });
      expect(skipped).toBeUndefined();

      // Cursor should not have moved, so we can still access the function call
      result.expect.nextEvent().isFunctionCall({ name: 'getWeather' });
    });

    it('should skip function call matching criteria', async () => {
      const result = session.run({ userInput: "What's the weather in Seattle?" });
      await result.wait();

      const skipped = result.expect.skipNextEventIf({
        type: 'function_call',
        name: 'getWeather',
      });
      expect(skipped).toBeDefined();

      // Next should be function_call_output
      result.expect.nextEvent().isFunctionCallOutput();
    });

    it('should not skip function call with wrong name', async () => {
      const result = session.run({ userInput: "What's the weather in Chicago?" });
      await result.wait();

      const skipped = result.expect.skipNextEventIf({
        type: 'function_call',
        name: 'wrongTool',
      });
      expect(skipped).toBeUndefined();

      // Cursor should still be at first event
      result.expect.nextEvent().isFunctionCall({ name: 'getWeather' });
    });
  });

  describe('range and contains assertions', () => {
    it('should find function call with containsFunctionCall()', async () => {
      const result = session.run({ userInput: "What's the weather in Denver?" });
      await result.wait();

      // Search all events for the function call
      result.expect.containsFunctionCall({ name: 'getWeather' });
    });

    it('should find message with containsMessage()', async () => {
      const result = session.run({ userInput: "What's the weather in Boston?" });
      await result.wait();

      // Should find the assistant message even though it's the last event
      result.expect.containsMessage({ role: 'assistant' });
    });

    it('should find function call output with containsFunctionCallOutput()', async () => {
      const result = session.run({ userInput: "What's the weather in Austin?" });
      await result.wait();

      result.expect.containsFunctionCallOutput();
    });

    it('should support range() for subset search', async () => {
      const result = session.run({ userInput: "What's the weather in Dallas?" });
      await result.wait();

      // Search only first two events
      result.expect.range(0, 2).containsFunctionCall({ name: 'getWeather' });

      // Message is at index 2, so range(0, 2) should NOT find it
      expect(() => {
        result.expect.range(0, 2).containsMessage({ role: 'assistant' });
      }).toThrow('No ChatMessageEvent matching criteria found');
    });

    it('should support negative indices in at()', async () => {
      const result = session.run({ userInput: "What's the weather in Phoenix?" });
      await result.wait();

      // -1 is the last event (message)
      result.expect.at(-1).isMessage({ role: 'assistant' });
      // -2 is the function_call_output
      result.expect.at(-2).isFunctionCallOutput();
      // -3 is the function_call
      result.expect.at(-3).isFunctionCall({ name: 'getWeather' });
    });
  });

  describe('judge assertions', () => {
    it('should pass judgment for weather description', async () => {
      const result = session.run({ userInput: "What's the weather in San Francisco?" });
      await result.wait();

      await result.expect.at(-1).isMessage({ role: 'assistant' }).judge(llmInstance, {
        intent: 'should describe the weather conditions or temperature',
      });
    });

    it('should pass judgment for time response', async () => {
      const result = session.run({ userInput: 'Can you tell me the current time?' });
      await result.wait();

      await result.expect.at(-1).isMessage({ role: 'assistant' }).judge(llmInstance, {
        intent: 'should tell the user what time it is',
      });
    });

    it('should pass judgment for order confirmation', async () => {
      const result = session.run({ userInput: 'Order me a classic burger, medium size' });
      await result.wait();

      // Skip function call events to get to the assistant message
      result.expect.skipNextEventIf({ type: 'function_call' });
      result.expect.skipNextEventIf({ type: 'function_call_output' });

      await result.expect.at(-1).isMessage({ role: 'assistant' }).judge(llmInstance, {
        intent: 'should confirm that the burger was added to the order or acknowledge the order',
      });
    });

    it('should fail judgment for incorrect intent', async () => {
      const result = session.run({ userInput: 'Hi!' });
      await result.wait();

      await expect(
        result.expect.nextEvent().isMessage({ role: 'assistant' }).judge(llmInstance, {
          intent: 'must provide detailed nutritional information about burgers',
        }),
      ).rejects.toThrow('Judgment failed');
    });
  });

  describe('completion state', () => {
    it('should track done() state correctly', async () => {
      const result = session.run({ userInput: 'Goodbye!' });

      expect(result.done()).toBe(false);
      await result.wait();
      expect(result.done()).toBe(true);
    });
  });

  describe('error cases', () => {
    it('should throw when expecting wrong event type', async () => {
      const result = session.run({ userInput: 'Hi!' });
      await result.wait();

      expect(() => {
        result.expect.nextEvent().isFunctionCall({ name: 'getWeather' });
      }).toThrow('Expected FunctionCallEvent');
    });

    it('should throw when expecting wrong function name', async () => {
      const result = session.run({ userInput: "What's the weather in NYC?" });
      await result.wait();

      expect(() => {
        result.expect.nextEvent().isFunctionCall({ name: 'wrongName' });
      }).toThrow("Expected call name 'wrongName'");
    });

    it('should throw when expecting wrong role', async () => {
      const result = session.run({ userInput: 'Hey!' });
      await result.wait();

      expect(() => {
        result.expect.nextEvent().isMessage({ role: 'user' });
      }).toThrow("Expected role 'user'");
    });

    it('should throw on noMoreEvents() when events remain', async () => {
      const result = session.run({ userInput: "What's the weather in Berlin?" });
      await result.wait();

      result.expect.nextEvent().isFunctionCall({ name: 'getWeather' });
      expect(() => {
        result.expect.noMoreEvents();
      }).toThrow('Expected no more events');
    });

    it('should throw on nextEvent() when exhausted', async () => {
      const result = session.run({ userInput: 'Bye!' });
      await result.wait();

      result.expect.nextEvent().isMessage({ role: 'assistant' });
      expect(() => {
        result.expect.nextEvent();
      }).toThrow('Expected another event, but none left');
    });

    it('should throw on at() with out of bounds index', async () => {
      const result = session.run({ userInput: 'Test!' });
      await result.wait();

      expect(() => {
        result.expect.at(10);
      }).toThrow('out of range');
    });

    it('should throw on containsFunctionCall() when not found', async () => {
      const result = session.run({ userInput: 'Hello!' });
      await result.wait();

      expect(() => {
        result.expect.containsFunctionCall({ name: 'nonExistentTool' });
      }).toThrow('No FunctionCallEvent satisfying criteria found');
    });
  });
});
