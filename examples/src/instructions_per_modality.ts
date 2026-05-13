// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type JobContext,
  type JobProcess,
  ServerOptions,
  cli,
  defineAgent,
  inference,
  llm,
  log,
  voice,
} from '@livekit/agents';
import * as silero from '@livekit/agents-plugin-silero';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const BASE_INSTRUCTIONS = (modalitySpecific: string, currentDate: string) =>
  `You are a scheduling assistant named Alex that helps users book appointments.
${modalitySpecific}
Call \`book_appointment\` to finalise the booking.
Never invent or assume details the user did not provide — ask for them instead.
The current date is ${currentDate}.
`;

// Voice users speak in approximate, self-correcting natural language.
// The LLM needs guidance on how to parse what was said, not how to say things back.
const AUDIO_SPECIFIC = `
The user is speaking — their input arrives as voice transcription and may be imperfect.
When interpreting what the user said:
- Resolve relative spoken expressions to a concrete date/time: 'next Tuesday', 'tomorrow afternoon', 'the week after next around 3'.
- Spoken numbers may be ambiguous: 'three thirty' could mean 3:30 PM or the 30th of March — ask for clarification when context does not make it obvious.
- Honor verbal self-corrections: if the user says 'wait, I meant Thursday not Tuesday', update your understanding to Thursday and discard Tuesday.
- Ignore filler words and hesitations ('um', 'uh', 'like', 'I guess').
- Always confirm the resolved date and time out loud before booking, since spoken input is inherently ambiguous.
`;

// Text users type precise values — no need to normalise spoken patterns.
const TEXT_SPECIFIC = `
The user is typing — take their input literally.
When interpreting what the user wrote:
- Accept exact dates and times in any common format (ISO, natural language, 12-hour or 24-hour clock).
- If the user provides a complete and unambiguous date and time, you may book immediately without asking for confirmation.
- Only ask follow-up questions for genuinely missing information.
`;

class SchedulingAgent extends voice.Agent {
  constructor() {
    const now = new Date();
    const weekday = now.toLocaleDateString(undefined, { weekday: 'long' });
    const currentDate = `${now.toISOString().slice(0, 10)} ${weekday}`;
    const instructions = new llm.Instructions({
      audio: BASE_INSTRUCTIONS(AUDIO_SPECIFIC, currentDate),
      text: BASE_INSTRUCTIONS(TEXT_SPECIFIC, currentDate),
    });

    super({
      instructions,
      tools: {
        bookAppointment: llm.tool({
          description: 'Book an appointment.',
          parameters: z.object({
            date: z.string().describe('The date of the appointment in the format YYYY-MM-DD'),
            time: z.string().describe('The time of the appointment in the format HH:MM'),
          }),
          execute: async ({ date, time }) => {
            log().info(`booking appointment for ${date} at ${time}`);
            return `Appointment booked for ${date} at ${time}`;
          },
        }),
      },
    });
  }

  async onEnter(): Promise<void> {
    this.session.generateReply();
  }
}

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load();
  },
  entry: async (ctx: JobContext) => {
    const session = new voice.AgentSession({
      vad: ctx.proc.userData.vad! as silero.VAD,
      stt: new inference.STT({ model: 'deepgram/nova-3' }),
      llm: new inference.LLM({ model: 'openai/gpt-4.1-mini' }),
      tts: new inference.TTS({
        model: 'cartesia/sonic-3',
        voice: '9626c31c-bec5-4cca-baa8-f8ba9e84c8bc',
      }),
    });

    await session.start({ agent: new SchedulingAgent(), room: ctx.room });
  },
});

cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url) }));
