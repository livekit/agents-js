// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Integration test for the agent test framework (RunResult, RunAssert, EventAssert).
 * Uses a simple agent with tools to demonstrate all assertions.
 *
 * This test requires OPENAI_API_KEY to be set.
 *
 * Run with: pnpm test --filter=examples -- src/testing/run_result.test.ts
 */
import { initializeLogger, llm, voice } from '@livekit/agents';
import * as openai from '@livekit/agents-plugin-openai';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

initializeLogger({ pretty: false, level: 'warn' });

const { AgentSession, Agent } = voice;

/**
 * Simple test agent with tools for weather and time queries.
 */
class TestAgent extends Agent {
  constructor() {
    super({
      instructions: `You are a friendly assistant named Max.
Keep responses SHORT (1-2 sentences max).
Remember user names when introduced.
When asked about the weather, ALWAYS use the getWeather tool.
When asked about the time, ALWAYS use the getCurrentTime tool.`,
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
      },
    });
  }
}

describe('RunResult', { timeout: 120_000 }, () => {
  let session: InstanceType<typeof AgentSession>;
  let agent: TestAgent;

  beforeAll(async () => {
    const llm = new openai.LLM({ model: 'gpt-4o-mini', temperature: 0 });
    session = new AgentSession({ llm });
    agent = new TestAgent();
    await session.start({ agent });
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
  });
});
