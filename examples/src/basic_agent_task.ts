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
  voice,
} from '@livekit/agents';
import * as openai from '@livekit/agents-plugin-openai';
import * as silero from '@livekit/agents-plugin-silero';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

let nextAppointmentId = 1;

/** Collects a single free-form field from the user and resolves with its value. */
class CollectInfoTask extends voice.AgentTask<string> {
  private field: string;

  constructor(field: string, hint?: string) {
    super({
      instructions:
        `You collect exactly one piece of information from the user: their ${field}.` +
        (hint ? ` ${hint}` : '') +
        ' As soon as the user provides it, call the saveInfo tool with the value.' +
        ' Do not chitchat, do not ask about anything else.',
      tools: {
        saveInfo: llm.tool({
          description: `Save the user's ${field}`,
          parameters: z.object({
            value: z.string().describe(`The user's ${field}, normalized`),
          }),
          execute: async ({ value }) => {
            this.complete(value);
            return `Saved ${field}: ${value}`;
          },
        }),
      },
    });
    this.field = field;
  }

  async onEnter() {
    this.session.generateReply({ userInput: `Ask the user for their ${this.field}.` });
  }
}

/** Reads a summary back to the user and resolves true/false. */
class ConfirmationTask extends voice.AgentTask<boolean> {
  private summary: string;

  constructor(summary: string) {
    super({
      instructions:
        'Read the summary back to the user and ask them to confirm with yes or no. ' +
        'Call the confirm tool if they agree, the decline tool if they do not. ' +
        'Do not discuss anything else.',
      // per-task TTS override: confirmations use a distinct voice
      tools: {
        confirm: llm.tool({
          description: 'The user confirmed the summary',
          execute: async () => {
            this.complete(true);
            return 'Confirmed';
          },
        }),
        decline: llm.tool({
          description: 'The user declined or wants to change something',
          execute: async () => {
            this.complete(false);
            return 'Declined';
          },
        }),
      },
    });
    this.summary = summary;
  }

  async onEnter() {
    this.session.generateReply({
      userInput: `Read this back to the user and ask them to confirm: ${this.summary}`,
    });
  }
}

class BillingAgent extends voice.Agent {
  constructor() {
    super({
      instructions:
        'You are the billing specialist of a dental clinic. Answer billing questions briefly. ' +
        'When the billing topic is resolved, call backToFrontDesk.',
      tools: {
        lookupBalance: llm.tool({
          description: "Look up the caller's outstanding balance",
          execute: async () => 'The outstanding balance is $120, due June 30.',
        }),
        backToFrontDesk: llm.tool({
          description: 'Return the caller to the front desk when billing is resolved',
          execute: async () =>
            llm.handoff({ agent: new FrontDeskAgent(), returns: 'Back at the front desk.' }),
        }),
      },
    });
  }
}

class FrontDeskAgent extends voice.Agent {
  constructor() {
    super({
      instructions:
        'You are the front desk assistant of a dental clinic. Keep responses to one short ' +
        'sentence. Use bookAppointment to book, updateCallbackNumber to update contact info, ' +
        'and transferToBilling for billing questions.',
      tools: {
        bookAppointment: llm.tool({
          description: 'Book an appointment for a given service (cleaning, checkup, etc.)',
          parameters: z.object({
            service: z.string().describe('The requested service'),
          }),
          execute: async ({ service }) => {
            // tasks nested inside a tool call: collect missing info, then confirm
            const time = await new CollectInfoTask('preferred day and time').run();
            const confirmed = await new ConfirmationTask(`Booking a ${service} on ${time}.`).run();
            if (!confirmed) {
              return 'Booking cancelled by the user. Offer to start over.';
            }
            const id = `APT-${String(nextAppointmentId++).padStart(3, '0')}`;
            return `Booked: ${service} on ${time}. Confirmation number ${id}.`;
          },
        }),
        updateCallbackNumber: llm.tool({
          description: 'Update the phone number we should call the user back on',
          execute: async () => {
            const phone = await new CollectInfoTask(
              'callback phone number',
              'Expect a sequence of digits; read it back digit by digit when saving.',
            ).run();
            return `Callback number updated to ${phone}.`;
          },
        }),
        transferToBilling: llm.tool({
          description: 'Transfer the caller to the billing specialist',
          execute: async () =>
            llm.handoff({ agent: new BillingAgent(), returns: 'Transferring to billing.' }),
        }),
      },
    });
  }

  async onEnter() {
    // sequential intake tasks before the main conversation starts
    const name = await new CollectInfoTask('name').run();
    const reason = await new CollectInfoTask('reason for the visit').run();

    await this.session.say(
      `Thanks ${name}. I see you are calling about ${reason}. How can I help from here?`,
    );
  }
}

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load();
  },
  entry: async (ctx: JobContext) => {
    const session = new voice.AgentSession({
      vad: ctx.proc.userData.vad as silero.VAD,
      stt: new inference.STT({ model: 'deepgram/nova-3' }),
      llm: new openai.responses.LLM({ useWebSocket: true }),
      tts: new inference.TTS({
        model: 'cartesia/sonic-3',
        voice: '9626c31c-bec5-4cca-baa8-f8ba9e84c8bc',
      }),
    });

    await session.start({
      room: ctx.room,
      agent: new FrontDeskAgent(),
    });
  },
});

cli.runApp(
  new ServerOptions({
    agent: fileURLToPath(import.meta.url),
  }),
);
