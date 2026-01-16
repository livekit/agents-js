// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for the Drive-Thru agent.
 * Ports the Python test_agent.py test suite to TypeScript.
 *
 * These tests verify:
 * - Item ordering (regular items, combos)
 * - Order modifications (remove items)
 * - Size prompting
 * - Unavailable item handling
 * - Unknown item handling
 * - Consecutive orders
 * - Conversation context
 *
 * Run with: pnpm vitest run examples/src/drive-thru/test_agent.ts
 */
import { initializeLogger, llm, voice } from '@livekit/agents';
import * as openai from '@livekit/agents-plugin-openai';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DriveThruAgent, type UserData, newUserData } from './drivethru_agent.js';

initializeLogger({ pretty: false, level: 'warn' });

const { AgentSession } = voice;

type TestableAgentSession = InstanceType<typeof AgentSession> & {
  run(options: { userInput: string }): voice.testing.RunResult;
};

function mainLLM(): openai.LLM {
  return new openai.LLM({
    model: 'gpt-4.1',
    temperature: 0.45,
  });
}

function judgeLLM(): openai.LLM {
  return new openai.LLM({
    model: 'gpt-4.1',
    temperature: 0.45,
  });
}

describe('DriveThru Agent Tests', { timeout: 180_000 }, () => {
  describe('test_item_ordering', () => {
    let session: TestableAgentSession;
    let llmInstance: openai.LLM;
    let userdata: UserData;

    beforeAll(async () => {
      userdata = await newUserData();
      llmInstance = mainLLM();
      session = new AgentSession({
        llm: llmInstance,
        userData: userdata,
      }) as TestableAgentSession;
      await session.start({ agent: new DriveThruAgent(userdata) });
    }, 30_000);

    afterAll(async () => {
      await session?.close();
    });

    it('should order a Big Mac without meal', async () => {
      const result = session.run({ userInput: 'Can I get a Big Mac, no meal?' });
      await result.wait();

      // Some LLMs would confirm the order first
      result.expect.skipNextEventIf({ type: 'message', role: 'assistant' });
      result.expect.nextEvent().isFunctionCall({
        name: 'orderRegularItem',
        args: { itemId: 'big_mac' },
      });
      const fncOut = result.expect.nextEvent().isFunctionCallOutput();
      expect(fncOut.event().item.output).toContain('The item was added');
      result.expect.nextEvent().isMessage({ role: 'assistant' });
      result.expect.noMoreEvents();
    });

    it('should remove item from order', async () => {
      const result = session.run({ userInput: "No actually I don't want it" });
      await result.wait();

      result.expect.skipNextEventIf({ type: 'message', role: 'assistant' });
      result.expect.nextEvent().isFunctionCall({ name: 'listOrderItems' });
      result.expect.nextEvent().isFunctionCallOutput();
      result.expect.containsFunctionCall({ name: 'removeOrderItem' });
      result.expect.at(-1).isMessage({ role: 'assistant' });
    });

    it('should order a McFlurry Oreo', async () => {
      const result = session.run({ userInput: 'Can I get a McFlurry Oreo?' });
      await result.wait();

      result.expect.skipNextEventIf({ type: 'message', role: 'assistant' });
      result.expect.nextEvent().isFunctionCall({
        name: 'orderRegularItem',
        args: { itemId: 'sweet_mcflurry_oreo' },
      });
      result.expect.nextEvent().isFunctionCallOutput();
      result.expect.nextEvent().isMessage({ role: 'assistant' });
      result.expect.noMoreEvents();
    });
  });

  describe('test_meal_order', () => {
    let session: TestableAgentSession;
    let llmInstance: openai.LLM;
    let judgeInstance: openai.LLM;
    let userdata: UserData;

    beforeAll(async () => {
      userdata = await newUserData();
      llmInstance = mainLLM();
      judgeInstance = judgeLLM();
      session = new AgentSession({
        llm: llmInstance,
        userData: userdata,
      }) as TestableAgentSession;
      await session.start({ agent: new DriveThruAgent(userdata) });
    }, 30_000);

    afterAll(async () => {
      await session?.close();
    });

    it('should prompt for drink when ordering combo without drink', async () => {
      // Add combo crispy, forgetting drink
      const result = session.run({
        userInput: 'Can I get a large Combo McCrispy Original with mayonnaise?',
      });
      await result.wait();

      const msgAssert = result.expect.nextEvent().isMessage({ role: 'assistant' });
      await msgAssert.judge(judgeInstance, {
        intent: 'should prompt the user to choose a drink',
      });
      result.expect.noMoreEvents();
    });

    it('should complete combo order with drink', async () => {
      const result = session.run({ userInput: 'a large coca cola' });
      await result.wait();

      result.expect.skipNextEventIf({ type: 'message', role: 'assistant' });
      result.expect.nextEvent().isFunctionCall({
        name: 'orderComboMeal',
        args: {
          mealId: 'combo_mccrispy_4a',
          drinkId: 'coca_cola',
          drinkSize: 'L',
          friesSize: 'L',
          sauceId: 'mayonnaise',
        },
      });
      result.expect.nextEvent().isFunctionCallOutput();
      result.expect.nextEvent().isMessage({ role: 'assistant' });
      result.expect.noMoreEvents();
    });
  });

  describe('test_unavailable_item', () => {
    let session: TestableAgentSession;
    let llmInstance: openai.LLM;
    let judgeInstance: openai.LLM;
    let userdata: UserData;

    beforeAll(async () => {
      userdata = await newUserData();

      // Make coca_cola unavailable
      for (const item of userdata.drinkItems) {
        if (item.id === 'coca_cola') {
          item.available = false;
        }
      }

      llmInstance = mainLLM();
      judgeInstance = judgeLLM();
      session = new AgentSession({
        llm: llmInstance,
        userData: userdata,
      }) as TestableAgentSession;
      await session.start({ agent: new DriveThruAgent(userdata) });
    }, 30_000);

    afterAll(async () => {
      await session?.close();
    });

    it('should inform user when item is unavailable', async () => {
      const result = session.run({ userInput: 'Can I get a large coca cola?' });
      await result.wait();

      // LLM may either tell user directly or try to order and get error
      try {
        await result.expect.nextEvent().isMessage({ role: 'assistant' }).judge(judgeInstance, {
          intent: 'should inform the user that the coca cola is unavailable',
        });
      } catch {
        // If the LLM tried to order, it should have failed
        result.expect.nextEvent().isFunctionCall({
          name: 'orderRegularItem',
          args: { itemId: 'coca_cola', size: 'L' },
        });
        result.expect.nextEvent().isFunctionCallOutput({ isError: true });
        await result.expect.nextEvent().isMessage({ role: 'assistant' }).judge(judgeInstance, {
          intent: 'should inform the user that the coca cola is unavailable',
        });
      }
      result.expect.noMoreEvents();
    });
  });

  describe('test_ask_for_size', () => {
    let session: TestableAgentSession;
    let llmInstance: openai.LLM;
    let judgeInstance: openai.LLM;
    let userdata: UserData;

    beforeAll(async () => {
      userdata = await newUserData();
      llmInstance = mainLLM();
      judgeInstance = judgeLLM();
      session = new AgentSession({
        llm: llmInstance,
        userData: userdata,
      }) as TestableAgentSession;
      await session.start({ agent: new DriveThruAgent(userdata) });
    }, 30_000);

    afterAll(async () => {
      await session?.close();
    });

    it('should ask for drink size when not specified', async () => {
      const result = session.run({ userInput: 'Can I get a fanta orange?' });
      await result.wait();

      await result.expect.nextEvent().isMessage({ role: 'assistant' }).judge(judgeInstance, {
        intent: 'should ask for the drink size',
      });
      result.expect.noMoreEvents();
    });

    it('should order with specified size', async () => {
      const result = session.run({ userInput: 'a small one' });
      await result.wait();

      result.expect.skipNextEventIf({ type: 'message', role: 'assistant' });
      result.expect.nextEvent().isFunctionCall({
        name: 'orderRegularItem',
        args: { itemId: 'fanta_orange', size: 'S' },
      });
      result.expect.nextEvent().isFunctionCallOutput();
      await result.expect.nextEvent().isMessage({ role: 'assistant' }).judge(judgeInstance, {
        intent: 'should confirm that the fanta orange was ordered',
      });
      result.expect.noMoreEvents();
    });
  });

  describe('test_consecutive_order', () => {
    it('should handle ordering multiple sauces', async () => {
      const userdata = await newUserData();
      const llmInstance = mainLLM();
      const judgeInstance = judgeLLM();
      const session = new AgentSession({
        llm: llmInstance,
        userData: userdata,
      }) as TestableAgentSession;
      await session.start({ agent: new DriveThruAgent(userdata) });

      try {
        const result = session.run({ userInput: 'Can I get two mayonnaise sauces?' });
        await result.wait();

        result.expect.skipNextEventIf({ type: 'message', role: 'assistant' });

        // Verify we have two mayonnaise sauces
        let numMayonnaise = 0;
        for (const item of Object.values(userdata.order.items)) {
          if (item.type === 'regular' && item.itemId === 'mayonnaise') {
            numMayonnaise++;
          }
        }
        expect(numMayonnaise).toBe(2);

        await result.expect.at(-1).isMessage({ role: 'assistant' }).judge(judgeInstance, {
          intent: 'should confirm that two mayonnaise sauces was ordered',
        });
      } finally {
        await session.close();
      }
    });

    it('should handle ordering multiple different items', async () => {
      const userdata = await newUserData();
      const llmInstance = mainLLM();
      const judgeInstance = judgeLLM();
      const session = new AgentSession({
        llm: llmInstance,
        userData: userdata,
      }) as TestableAgentSession;
      await session.start({ agent: new DriveThruAgent(userdata) });

      try {
        const result = session.run({
          userInput: 'Can I get a ketchup sauce and a McFlurry Oreo?',
        });
        await result.wait();

        result.expect.containsFunctionCall({
          name: 'orderRegularItem',
          args: { itemId: 'ketchup' },
        });
        result.expect.containsFunctionCall({
          name: 'orderRegularItem',
          args: { itemId: 'sweet_mcflurry_oreo' },
        });
        await result.expect.at(-1).isMessage({ role: 'assistant' }).judge(judgeInstance, {
          intent: 'should confirm that a ketchup and a McFlurry Oreo was ordered',
        });
      } finally {
        await session.close();
      }
    });
  });

  describe('test_conv', () => {
    let session: TestableAgentSession;
    let llmInstance: openai.LLM;
    let judgeInstance: openai.LLM;
    let userdata: UserData;
    let agent: DriveThruAgent;

    beforeAll(async () => {
      userdata = await newUserData();
      llmInstance = mainLLM();
      judgeInstance = judgeLLM();
      agent = new DriveThruAgent(userdata);
      session = new AgentSession({
        llm: llmInstance,
        userData: userdata,
      }) as TestableAgentSession;
      await session.start({ agent });
    }, 30_000);

    afterAll(async () => {
      await session?.close();
    });

    it('should handle conversation with context', async () => {
      // Build conversation context
      const chatCtx = new llm.ChatContext();
      chatCtx.addMessage({ role: 'user', content: 'Hello, Can I get a Big Mac?' });
      chatCtx.addMessage({
        role: 'assistant',
        content:
          'Sure thing! Would you like that as a combo meal with fries and a drink, or just the Big Mac on its own?',
      });
      chatCtx.addMessage({ role: 'user', content: 'Yeah. With a meal' });
      chatCtx.addMessage({
        role: 'assistant',
        content: 'Great! What drink would you like with your Big Mac Combo?',
      });
      chatCtx.addMessage({ role: 'user', content: 'Cook. ' });
      chatCtx.addMessage({
        role: 'assistant',
        content: 'Did you mean a Coke for your drink?',
      });
      chatCtx.addMessage({ role: 'user', content: 'Yeah. ' });
      chatCtx.addMessage({
        role: 'assistant',
        content:
          'Alright, a Big Mac Combo with a Coke. What size would you like for your fries and drink? Medium or large?',
      });
      chatCtx.addMessage({ role: 'user', content: 'Large. ' });
      chatCtx.addMessage({
        role: 'assistant',
        content:
          'Got it! A Big Mac Combo with large fries and a Coke. What sauce would you like with that?',
      });

      await agent.updateChatCtx(chatCtx);

      const result = session.run({ userInput: 'mayonnaise' });
      await result.wait();

      result.expect.skipNextEventIf({ type: 'message', role: 'assistant' });
      result.expect.nextEvent().isFunctionCall({
        name: 'orderComboMeal',
        args: {
          mealId: 'combo_big_mac',
          drinkId: 'coca_cola',
          drinkSize: 'L',
          friesSize: 'L',
          sauceId: 'mayonnaise',
        },
      });
      result.expect.nextEvent().isFunctionCallOutput();
      await result.expect.nextEvent().isMessage({ role: 'assistant' }).judge(judgeInstance, {
        intent: 'must confirm a Big Mac Combo meal was added/ordered',
      });
      result.expect.noMoreEvents();
    });
  });

  describe('test_unknown_item', () => {
    it('should handle unknown burger item', async () => {
      const userdata = await newUserData();
      const llmInstance = mainLLM();
      const judgeInstance = judgeLLM();
      const session = new AgentSession({
        llm: llmInstance,
        userData: userdata,
      }) as TestableAgentSession;
      const agent = new DriveThruAgent(userdata);
      await session.start({ agent });

      try {
        const result = session.run({ userInput: 'Can I get a double hamburger? No meal' });
        await result.wait();

        await result.expect.nextEvent().isMessage({ role: 'assistant' }).judge(judgeInstance, {
          intent: "should say it isn't something they have, or suggest something similar",
        });
        result.expect.noMoreEvents();
      } finally {
        await session.close();
      }
    });

    it('should handle unknown drink item', async () => {
      const userdata = await newUserData();
      const llmInstance = mainLLM();
      const judgeInstance = judgeLLM();
      const session = new AgentSession({
        llm: llmInstance,
        userData: userdata,
      }) as TestableAgentSession;
      const agent = new DriveThruAgent(userdata);
      await session.start({ agent });

      try {
        const result = session.run({ userInput: 'Can I get a redbull?' });
        await result.wait();

        await result.expect.nextEvent().isMessage({ role: 'assistant' }).judge(judgeInstance, {
          intent: "should say they don't have a redbull",
        });
        result.expect.noMoreEvents();
      } finally {
        await session.close();
      }
    });
  });
});
