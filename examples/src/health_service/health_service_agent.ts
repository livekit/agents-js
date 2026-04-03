// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type JobContext,
  type JobProcess,
  ServerOptions,
  beta,
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

type SchedulingIntent = 'schedule';

interface PatientIdentity {
  fullName: string;
  dateOfBirth: string;
}

interface ScheduledVisitResult {
  confirmationId: string;
  preferredDateTime: string;
  status: 'scheduled';
}

export interface HealthServiceUserData {
  verifiedIntent?: SchedulingIntent;
  identifiedPatient?: PatientIdentity;
  scheduledVisit?: ScheduledVisitResult;
}

class VerifyIntentTask extends voice.AgentTask<SchedulingIntent> {
  constructor() {
    super({
      instructions: "Verify the user's intent to schedule a patient appointment.",
      tools: {
        verifyIntent: llm.tool({
          description: 'Mark that the user confirmed they want to schedule a patient visit.',
          parameters: z.object({
            intent: z.enum(['schedule']),
          }),
          execute: async ({ intent }, { ctx }: llm.ToolOptions<HealthServiceUserData>) => {
            ctx.userData.verifiedIntent = intent;
            this.complete(intent);
            return 'Intent verified.';
          },
        }),
      },
    });
  }

  async onEnter() {
    await this.session.generateReply({
      instructions:
        'Ask user if they want to schedule an appointment. That said, do not say anything more. Just one brief sentence is enough.',
      toolChoice: 'none',
    });
  }
}

class IdentifyPatientTask extends voice.AgentTask<PatientIdentity> {
  constructor() {
    super({
      instructions:
        'You are handling step two of a healthcare scheduling flow. Ask for the patient full name and date of birth, then verify identity with identifyPatient. Dates of birth must be normalized to YYYY-MM-DD before calling the tool.',
      tools: {
        identifyPatient: llm.tool({
          description: 'Identify a patient from their full name and date of birth.',
          parameters: z.object({
            fullName: z.string().describe('Full legal name of the patient.'),
            dateOfBirth: z
              .string()
              .describe('Date of birth normalized to YYYY-MM-DD format before the tool call.'),
          }),
          execute: async (
            { fullName, dateOfBirth },
            { ctx }: llm.ToolOptions<HealthServiceUserData>,
          ) => {
            const patient: PatientIdentity = {
              fullName,
              dateOfBirth,
            };

            ctx.userData.identifiedPatient = patient;
            this.complete(patient);
            return `Verified patient ${patient.fullName}.`;
          },
        }),
      },
    });
  }

  async onEnter() {
    await this.session.generateReply({
      instructions:
        'Ask for the patient full name and date of birth. Once you have both, call identifyPatient.',
      toolChoice: 'none',
    });
  }
}

class SchedulePatientVisitTask extends voice.AgentTask<ScheduledVisitResult> {
  constructor() {
    super({
      instructions:
        'You are handling step three of a healthcare scheduling flow. Ask for a preferred date and time, then schedule the appointment by calling schedulePatientVisit.',
      tools: {
        schedulePatientVisit: llm.tool({
          description: 'Schedule a patient appointment for the verified patient (mock success).',
          parameters: z.object({
            preferredDateTime: z
              .string()
              .describe('User preferred date and time for the appointment.'),
          }),
          execute: async (
            { preferredDateTime },
            { ctx }: llm.ToolOptions<HealthServiceUserData>,
          ) => {
            const patient = ctx.userData.identifiedPatient;
            if (!patient) {
              throw new llm.ToolError('No verified patient is available for scheduling.');
            }

            const visit: ScheduledVisitResult = {
              confirmationId: `confirm_${Date.now()}`,
              preferredDateTime,
              status: 'scheduled',
            };
            ctx.userData.scheduledVisit = visit;
            this.complete(visit);
            return `Scheduled ${patient.fullName} for ${preferredDateTime}. Confirmation ID: ${visit.confirmationId}.`;
          },
        }),
      },
    });
  }

  async onEnter() {
    await this.session.generateReply({
      instructions:
        'Ask the user for their preferred appointment date and time, then call schedulePatientVisit once they provide it.',
      toolChoice: 'none',
    });
  }
}

export class HealthServiceAgent extends voice.Agent<HealthServiceUserData> {
  constructor() {
    super({
      instructions:
        'You are a concise healthcare scheduling assistant. When the user asks to schedule a patient appointment, call startPatientSchedulingFlow exactly once.',
    });
  }

  async onEnter() {
    const group = new beta.TaskGroup({
      summarizeChatCtx: true,
    });

    group.add(() => new VerifyIntentTask(), {
      id: 'verify_intent',
      description: 'Confirm the user wants to schedule a patient appointment',
    });
    group.add(() => new IdentifyPatientTask(), {
      id: 'identify_patient',
      description: 'Collect patient name and date of birth',
    });
    group.add(() => new SchedulePatientVisitTask(), {
      id: 'schedule_patient_visit',
      description: 'Offer slots and schedule the patient visit',
    });

    await group.run();
    this.session.say(`Your appointment has been scheduled! Thank you for using our service.`);
  }
}

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load();
  },
  entry: async (ctx: JobContext) => {
    const session = new voice.AgentSession<HealthServiceUserData>({
      vad: ctx.proc.userData.vad as silero.VAD,
      stt: new inference.STT({ model: 'deepgram/nova-3' }),
      llm: new openai.responses.LLM({
        model: 'gpt-5.2',
      }),
      tts: new inference.TTS({
        model: 'cartesia/sonic-3',
        voice: '9626c31c-bec5-4cca-baa8-f8ba9e84c8bc',
      }),
      userData: {},
    });

    await session.start({
      room: ctx.room,
      agent: new HealthServiceAgent(),
    });
  },
});

// Only run CLI when executed directly, not when imported for testing.
// eslint-disable-next-line turbo/no-undeclared-env-vars
if (process.env.VITEST === undefined) {
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url) }));
}
