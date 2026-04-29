// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type JobContext,
  type JobProcess,
  createAgentServer,
  dedent,
  defineAgent,
  llm,
  voice,
} from '@livekit/agents';
import * as deepgram from '@livekit/agents-plugin-deepgram';
import * as elevenlabs from '@livekit/agents-plugin-elevenlabs';
import * as livekit from '@livekit/agents-plugin-livekit';
import * as openai from '@livekit/agents-plugin-openai';
import * as silero from '@livekit/agents-plugin-silero';
import { BackgroundVoiceCancellation } from '@livekit/noise-cancellation-node';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  type AvailableSlot,
  CalComCalendar,
  type Calendar,
  FakeCalendar,
  SlotUnavailableError,
  getUniqueHash,
} from './calendar_api.js';

type FrontDeskProps = {
  cal: Calendar;
  timezone: string;
};

const FrontDeskAgent = defineAgent<FrontDeskProps>((ctx, props) => {
  const { cal, timezone } = props;

  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: timezone,
  });

  ctx.configure({
    instructions: dedent`
      You are Front-Desk, a helpful and efficient voice assistant.
      Today is ${today}. Your main goal is to schedule an appointment for the user.
      This is a voice conversation — speak naturally, clearly, and concisely.
      When the user says hello or greets you, don't just respond with a greeting — use it as an opportunity to move things forward.
      For example, follow up with a helpful question like: 'Would you like to book a time?'
      When asked for availability, call list_available_slots and offer a few clear, simple options.
      Say things like 'Monday at 2 PM' — avoid timezones, timestamps, and avoid saying 'AM' or 'PM'.
      Use natural phrases like 'in the morning' or 'in the evening', and don't mention the year unless it's different from the current one.
      Offer a few options at a time, pause for a response, then guide the user to confirm.
      If the time is no longer available, let them know gently and offer the next options.
      Always keep the conversation flowing — be proactive, human, and focused on helping the user schedule with ease.
    `,
  });

  const slots = ctx.state<Map<string, AvailableSlot>>(() => new Map());

  ctx.tool('scheduleAppointment', {
    description: 'Schedule an appointment at the given slot.',
    parameters: z.object({
      slotId: z
        .string()
        .describe(
          'The identifier for the selected time slot (as shown in the list of available slots).',
        ),
    }),
    execute: async ({ slotId }) => {
      const slot = slots.value.get(slotId);
      if (!slot) {
        throw new llm.ToolError(`error: slot ${slotId} was not found`);
      }

      // Placeholder: the Python version uses beta.workflows.GetEmailTask to
      // collect the user's email. Once AgentTask lands in JS, replace with:
      //   const email = await GetEmailTask({ chatCtx: ctx.chatCtx });
      const placeholderEmail = 'user@example.com';

      try {
        await ctx.step(
          () =>
            cal.scheduleAppointment({
              startTime: slot.startTime,
              attendeeEmail: placeholderEmail,
            }),
          'scheduleAppointment',
        );
      } catch (error) {
        if (error instanceof SlotUnavailableError) {
          throw new llm.ToolError("This slot isn't available anymore");
        }
        throw error;
      }

      const local = new Date(slot.startTime.toLocaleString('en-US', { timeZone: timezone }));
      const formatted = local.toLocaleDateString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        timeZoneName: 'short',
        timeZone: timezone,
      });

      return `The appointment was successfully scheduled for ${formatted}.`;
    },
  });

  ctx.tool('listAvailableSlots', {
    description: dedent`
      Return a plain-text list of available slots, one per line.

      <slot_id> - <Weekday>, <Month> <Day>, <Year> at <HH:MM> <TZ> (<relative time>)

      You must infer the appropriate range implicitly from the conversational context and must not prompt the user to pick a value explicitly.
    `,
    parameters: z.object({
      range: z
        .enum(['+2week', '+1month', '+3month', 'default'])
        .describe('Determines how far ahead to search for free time slots.'),
    }),
    execute: async ({ range }) => {
      const now = new Date();

      let rangeDays: number;
      if (range === '+2week' || range === 'default') {
        rangeDays = 14;
      } else if (range === '+1month') {
        rangeDays = 30;
      } else if (range === '+3month') {
        rangeDays = 90;
      } else {
        rangeDays = 14;
      }

      const endTime = new Date(now.getTime() + rangeDays * 24 * 60 * 60 * 1000);

      const available = await ctx.step(
        () => cal.listAvailableSlots({ startTime: now, endTime }),
        'listAvailableSlots',
      );

      const lines: string[] = [];
      const next = new Map(slots.value);

      for (const slot of available) {
        const local = new Date(slot.startTime.toLocaleString('en-US', { timeZone: timezone }));
        const delta = local.getTime() - now.getTime();
        const days = Math.floor(delta / (24 * 60 * 60 * 1000));
        const seconds = Math.floor((delta % (24 * 60 * 60 * 1000)) / 1000);

        let rel: string;
        if (local.toDateString() === now.toDateString()) {
          if (seconds < 3600) {
            rel = 'in less than an hour';
          } else {
            rel = 'later today';
          }
        } else if (
          local.toDateString() === new Date(now.getTime() + 24 * 60 * 60 * 1000).toDateString()
        ) {
          rel = 'tomorrow';
        } else if (days < 7) {
          rel = `in ${days} days`;
        } else if (days < 14) {
          rel = 'in 1 week';
        } else {
          rel = `in ${Math.floor(days / 7)} weeks`;
        }

        const uniqueHash = getUniqueHash(slot);
        const formatted = local.toLocaleDateString('en-US', {
          weekday: 'long',
          year: 'numeric',
          month: 'long',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          timeZoneName: 'short',
          timeZone: timezone,
        });

        lines.push(`${uniqueHash} - ${formatted} (${rel})`);
        next.set(uniqueHash, slot);
      }

      slots.value = next;
      return lines.join('\n') || 'No slots available at the moment.';
    },
  });

  ctx.onEnter(async () => {
    await ctx.generateReply({ userInput: 'Greet to the user' });
  });
});

async function loadCalendar(timezone: string): Promise<Calendar> {
  const calApiKey = process.env.CAL_API_KEY;
  const cal = calApiKey
    ? new CalComCalendar({ apiKey: calApiKey, timezone })
    : new FakeCalendar({ timezone });
  await cal.initialize();
  return cal;
}

const app = createAgentServer();

app.prewarm(async (proc: JobProcess) => {
  proc.userData.vad = await silero.VAD.load();
});

app.rtc(async (ctx: JobContext) => {
  const timezone = 'UTC';

  if (!process.env.CAL_API_KEY) {
    console.warn(
      'CAL_API_KEY is not set. Falling back to FakeCalendar; set CAL_API_KEY to enable Cal.com integration.',
    );
  }

  const cal = await loadCalendar(timezone);

  const session = new voice.AgentSession({
    vad: ctx.proc.userData.vad! as silero.VAD,
    stt: new deepgram.STT(),
    llm: new openai.LLM({
      model: 'gpt-4.1',
    }),
    tts: new elevenlabs.TTS(),
    turnDetection: new livekit.turnDetector.MultilingualModel(),
    voiceOptions: {
      maxToolSteps: 1,
    },
  });

  await session.start({
    agent: FrontDeskAgent({ cal, timezone }),
    room: ctx.room,
    inputOptions: {
      noiseCancellation: BackgroundVoiceCancellation(),
    },
  });
});

// Only run CLI when executed directly, not when imported for testing
// eslint-disable-next-line turbo/no-undeclared-env-vars
if (process.env.VITEST === undefined) {
  app.run({ path: fileURLToPath(import.meta.url) });
}

export default app;
