// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for the FrontDesk agent.
 * Ports the Python test_agent.py test suite to TypeScript.
 *
 * Note: The email collection workflow (beta.workflows.GetEmailTask) is not yet
 * available in TypeScript. Tests that rely on this feature are simplified to
 * test the available functionality.
 *
 * These tests verify:
 * - Slot listing and scheduling
 * - No availability handling
 *
 * Run with: pnpm vitest run examples/src/frontdesk/test_agent.ts
 */
import { initializeLogger, voice } from '@livekit/agents';
import * as openai from '@livekit/agents-plugin-openai';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { type AvailableSlot, FakeCalendar, createAvailableSlot } from './calendar_api.js';
import { FrontDeskAgent, type Userdata } from './frontdesk_agent.js';

initializeLogger({ pretty: false, level: 'warn' });

const { AgentSession } = voice;

type TestableAgentSession = InstanceType<typeof AgentSession> & {
  run(options: { userInput: string }): voice.testing.RunResult;
};

const TIMEZONE = 'UTC';

function llmModel(): openai.LLM {
  return new openai.LLM({
    model: 'gpt-4.1',
    temperature: 0.45,
  });
}

/**
 * Helper to create a Date at a specific hour on a given date in UTC
 */
function createTimeSlotUTC(baseDate: Date, hour: number, minute: number = 0): Date {
  const result = new Date(baseDate);
  result.setUTCHours(hour, minute, 0, 0);
  return result;
}

/**
 * Get today's date at midnight in UTC
 */
function getTodayUTC(): Date {
  const now = new Date();
  now.setUTCHours(0, 0, 0, 0);
  return now;
}

describe('FrontDesk Agent Tests', { timeout: 180_000 }, () => {
  describe('test_slot_scheduling', () => {
    let session: TestableAgentSession;
    let llmInstance: openai.LLM;
    let slots: AvailableSlot[];
    let userdata: Userdata;

    beforeAll(async () => {
      const today = getTodayUTC();
      const tomorrow = new Date(today);
      tomorrow.setUTCDate(today.getUTCDate() + 1);
      const dayAfterTomorrow = new Date(today);
      dayAfterTomorrow.setUTCDate(today.getUTCDate() + 2);

      // Create slots similar to Python test (all times in UTC)
      slots = [
        // Today slots
        createAvailableSlot(createTimeSlotUTC(today, 9, 0), 30),
        createAvailableSlot(createTimeSlotUTC(today, 9, 30), 30),
        createAvailableSlot(createTimeSlotUTC(today, 10, 0), 30),

        // Tomorrow slots
        createAvailableSlot(createTimeSlotUTC(tomorrow, 14, 0), 30),
        createAvailableSlot(createTimeSlotUTC(tomorrow, 14, 30), 30),
        createAvailableSlot(createTimeSlotUTC(tomorrow, 15, 0), 30),

        // Day after tomorrow slots
        createAvailableSlot(createTimeSlotUTC(dayAfterTomorrow, 11, 0), 30),
        createAvailableSlot(createTimeSlotUTC(dayAfterTomorrow, 11, 30), 30),
      ];

      userdata = {
        cal: new FakeCalendar({ timezone: TIMEZONE, slots }),
      };

      llmInstance = llmModel();
      session = new AgentSession({
        llm: llmInstance,
        userData: userdata,
      }) as TestableAgentSession;
      await session.start({ agent: new FrontDeskAgent({ timezone: TIMEZONE }) });
    }, 30_000);

    afterAll(async () => {
      await session?.close();
    });

    it('should list available slots for tomorrow when asked', async () => {
      const result = session.run({ userInput: 'Can I get an appointment tomorrow?' });
      await result.wait();

      result.expect.skipNextEventIf({ type: 'message', role: 'assistant' });
      result.expect.nextEvent().isFunctionCall({ name: 'listAvailableSlots' });
      result.expect.nextEvent().isFunctionCallOutput();

      // Verify the assistant suggests appointment times
      await result.expect
        .nextEvent()
        .isMessage({ role: 'assistant' })
        .judge(llmInstance, {
          intent:
            'must suggest one or more available appointment time slots for tomorrow. ' +
            'Should mention specific times that the user can book.',
        });
    });

    it('should schedule appointment when user selects a time', async () => {
      // User selects one of the offered times (the first available slot tomorrow)
      const result = session.run({ userInput: 'The first available time tomorrow sounds good' });
      await result.wait();

      // Agent may ask clarifying questions or directly schedule
      // We're flexible here since the exact flow depends on how the agent interprets "first available"
      const hasScheduleCall = result.events.some(
        (e) =>
          e.type === 'function_call' &&
          e.item &&
          'name' in e.item &&
          e.item.name === 'scheduleAppointment',
      );

      if (hasScheduleCall) {
        // Agent scheduled directly
        result.expect.containsFunctionCall({ name: 'scheduleAppointment' });
        await result.expect.at(-1).isMessage({ role: 'assistant' }).judge(llmInstance, {
          intent: 'must confirm the appointment was scheduled or provide appointment details',
        });
      } else {
        // Agent asked for clarification or offered more specific options
        await result.expect.at(-1).isMessage({ role: 'assistant' }).judge(llmInstance, {
          intent:
            'should either confirm the appointment, ask for clarification, or suggest specific time options',
        });
      }
    });
  });

  describe('test_no_availability', () => {
    let session: TestableAgentSession;
    let llmInstance: openai.LLM;
    let userdata: Userdata;

    beforeAll(async () => {
      // No slots available
      userdata = {
        cal: new FakeCalendar({ timezone: TIMEZONE, slots: [] }),
      };

      llmInstance = llmModel();
      session = new AgentSession({
        llm: llmInstance,
        userData: userdata,
      }) as TestableAgentSession;
      await session.start({ agent: new FrontDeskAgent({ timezone: TIMEZONE }) });
    }, 30_000);

    afterAll(async () => {
      await session?.close();
    });

    it('should inform user when no slots are available', async () => {
      const result = session.run({
        userInput:
          "Hello, can I need an appointment, what's your availability for the next 2 weeks?",
      });
      await result.wait();

      result.expect.skipNextEventIf({ type: 'message', role: 'assistant' });
      result.expect.nextEvent().isFunctionCall({ name: 'listAvailableSlots' });
      result.expect.nextEvent().isFunctionCallOutput();
      await result.expect.nextEvent().isMessage({ role: 'assistant' }).judge(llmInstance, {
        intent:
          'must say that there is no availability, especially in the requested time range. optionally, it can offer to look at other times',
      });
    });
  });
});
