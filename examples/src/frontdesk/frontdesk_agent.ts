// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type JobContext,
  ServerOptions,
  cli,
  defineAgent,
  inference,
  llm,
  log,
  voice,
} from '@livekit/agents';
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

export interface Userdata {
  cal: Calendar;
}

export class FrontDeskAgent extends voice.Agent {
  private tz: string;
  private _slotsMap: Map<string, AvailableSlot> = new Map();

  constructor(options: { timezone: string }) {
    const today = new Date().toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      timeZone: options.timezone,
    });

    const instructions =
      // Outcome — what a great interaction looks like.
      `You are Front-Desk, a helpful and efficient voice assistant. Today is ${today}. ` +
      `A great interaction ends with the user booked into an appointment slot that works ` +
      `for them, reached through a warm, flowing conversation with as little ` +
      `back-and-forth as possible. ` +
      // Voice & personality — keep it short and human.
      `Your output is synthesized directly to speech, so produce a natural verbatim ` +
      `transcript, not polished text. Start responses with real reactions (oh, hmm, ah) ` +
      `and fillers (um, uh, like) rather than "Absolutely" or "Certainly", with ` +
      `mid-sentence fillers (like, you know, I mean) where they'd naturally fall. Mirror ` +
      `the user's formality: if they're casual, use informal phrasing (gotcha, alright, ` +
      `gonna, kinda, lemme, yeah); if they're more formal, keep your speech cleaner. Vary ` +
      `your openers across turns — if you opened the last turn with 'gotcha', pick ` +
      `'alright' or 'okay' this turn; don't repeat the same opener back-to-back. ` +
      // How to work — be proactive, acknowledge before acting, stop when you can move forward.
      `Be proactive: when the user greets you, use it to move things forward (e.g. ` +
      `'Would you like to book a time?') rather than just greeting back. Before a tool ` +
      `call that takes a moment, give a brief spoken acknowledgment so there's no dead ` +
      `air. After each result, check whether you can now move the user toward a booking: ` +
      `if so, do it; if you're missing something, ask for just that. ` +
      // Speaking about times — constraints that keep it natural over voice.
      `When talking about availability, call list_available_slots and offer a few clear ` +
      `options at a time, then pause for a response and guide the user to confirm. Say ` +
      `times like 'Monday at 2' — avoid timezones, timestamps, and the words 'AM'/'PM'; ` +
      `use natural phrases like 'in the morning' or 'in the evening', and don't mention ` +
      `the year unless it differs from the current one. When listing several times in the ` +
      `same window, group them ('in the evening at 4, 5, or 6') instead of repeating the ` +
      `time-of-day qualifier on each slot. If a chosen time is no longer available, let ` +
      `them know gently and offer the next options.`;

    super({
      instructions,
      tools: [
        llm.tool({
          name: 'scheduleAppointment',
          description: 'Schedule an appointment at the given slot.',
          parameters: z.object({
            slotId: z
              .string()
              .describe(
                'The identifier for the selected time slot (as shown in the list of available slots).',
              ),
          }),
          execute: async ({ slotId }, { ctx }: llm.ToolOptions<Userdata>) => {
            const slot = this._slotsMap.get(slotId);
            if (!slot) {
              throw new llm.ToolError(`error: slot ${slotId} was not found`);
            }

            // Note: The Python version uses beta.workflows.GetEmailTask which is not available in TypeScript yet
            // For now, we'll use a placeholder email
            const placeholderEmail = 'user@example.com';

            console.warn(
              'Note: Email collection workflow not implemented in TypeScript version yet. Using placeholder email.',
            );

            try {
              await ctx.userData.cal.scheduleAppointment({
                startTime: slot.startTime,
                attendeeEmail: placeholderEmail,
              });
            } catch (error) {
              if (error instanceof SlotUnavailableError) {
                throw new llm.ToolError("This slot isn't available anymore");
              }
              throw error;
            }

            const local = new Date(slot.startTime.toLocaleString('en-US', { timeZone: this.tz }));
            const formatted = local.toLocaleDateString('en-US', {
              weekday: 'long',
              year: 'numeric',
              month: 'long',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
              timeZoneName: 'short',
              timeZone: this.tz,
            });

            return `The appointment was successfully scheduled for ${formatted}.`;
          },
        }),
        llm.tool({
          name: 'listAvailableSlots',
          description: `Return a plain-text list of available slots, one per line.

<slot_id> - <Weekday>, <Month> <Day>, <Year> at <HH:MM> <TZ> (<relative time>)

You must infer the appropriate range implicitly from the conversational context and must not prompt the user to pick a value explicitly.`,
          parameters: z.object({
            range: z
              .enum(['+2week', '+1month', '+3month', 'default'])
              .describe('Determines how far ahead to search for free time slots.'),
          }),
          execute: async ({ range }, { ctx }: llm.ToolOptions<Userdata>) => {
            const now = new Date();
            const lines: string[] = [];

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

            const slots = await ctx.userData.cal.listAvailableSlots({
              startTime: now,
              endTime: endTime,
            });

            for (const slot of slots) {
              const local = new Date(slot.startTime.toLocaleString('en-US', { timeZone: this.tz }));
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
                local.toDateString() ===
                new Date(now.getTime() + 24 * 60 * 60 * 1000).toDateString()
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
                timeZone: this.tz,
              });

              lines.push(`${uniqueHash} - ${formatted} (${rel})`);
              this._slotsMap.set(uniqueHash, slot);
            }

            return lines.join('\n') || 'No slots available at the moment.';
          },
        }),
      ],
    });

    this.tz = options.timezone;
  }

  async onEnter(): Promise<void> {
    const hour = Number(
      new Intl.DateTimeFormat('en-US', {
        hour: 'numeric',
        hour12: false,
        timeZone: this.tz,
      }).format(new Date()),
    );
    const timeOfDay = hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';
    await this.session.generateReply({
      instructions:
        `Say hello and welcome to the caller — it's currently ${timeOfDay} their time. ` +
        `You're the front desk of an office and you're here to help them schedule a visit. ` +
        `Invite them to book an appointment to visit, and ask what time works. ` +
        `Keep it warm and brief.`,
    });
  }
}

export default defineAgent({
  entry: async (ctx: JobContext) => {
    const timezone = 'UTC';

    let cal: Calendar;
    const calApiKey = process.env.CAL_API_KEY;

    if (calApiKey) {
      console.log('CAL_API_KEY detected, using cal.com calendar');
      cal = new CalComCalendar({ apiKey: calApiKey, timezone });
    } else {
      console.warn(
        'CAL_API_KEY is not set. Falling back to FakeCalendar; set CAL_API_KEY to enable Cal.com integration.',
      );
      cal = new FakeCalendar({ timezone });
    }

    await cal.initialize();

    const userdata: Userdata = { cal };

    const session = new voice.AgentSession({
      stt: new inference.STT({ model: 'deepgram/nova-3' }),
      llm: new inference.LLM({ model: 'google/gemma-4-31b-it' }),
      tts: new inference.TTS({
        model: 'inworld/inworld-tts-2',
        voice: 'Nadia',
        modelOptions: { delivery_mode: 'CREATIVE', speaking_rate: 1.1 },
      }),
      expressive: voice.presets.CUSTOMER_SERVICE,
      userData: userdata,
      maxToolSteps: 1,
      // Flip userState to "away" after 10s of mutual silence so we can
      // check whether they're still there (default is 15s).
      userAwayTimeout: 10.0,
    });

    const logger = log();
    let idleNudge: AbortController | null = null;

    const nudgeWhileIdle = async (signal: AbortSignal) => {
      // Nudge every 10s until the user speaks again — speaking flips
      // userState out of "away", which aborts this loop below.
      while (!signal.aborted) {
        logger.info("user idle — checking if they're still there");
        await session.generateReply({
          instructions: "The user has been idle, see if they're still there",
        });
        await new Promise((resolve) => setTimeout(resolve, 10_000));
      }
    };

    session.on(voice.AgentSessionEventTypes.UserStateChanged, (ev) => {
      if (ev.newState === 'away') {
        if (idleNudge === null) {
          idleNudge = new AbortController();
          void nudgeWhileIdle(idleNudge.signal);
        }
      } else if (idleNudge !== null) {
        idleNudge.abort();
        idleNudge = null;
      }
    });

    await session.start({
      agent: new FrontDeskAgent({ timezone }),
      room: ctx.room,
      inputOptions: {
        noiseCancellation: BackgroundVoiceCancellation(),
      },
    });
  },
});

// Only run CLI when executed directly, not when imported for testing
// eslint-disable-next-line turbo/no-undeclared-env-vars
if (process.env.VITEST === undefined) {
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url) }));
}
