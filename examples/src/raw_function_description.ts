// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type JobContext,
  type JobProcess,
  WorkerOptions,
  cli,
  defineAgent,
  llm,
  voice,
} from '@livekit/agents';
import * as deepgram from '@livekit/agents-plugin-deepgram';
import * as elevenlabs from '@livekit/agents-plugin-elevenlabs';
import * as livekit from '@livekit/agents-plugin-livekit';
import * as openai from '@livekit/agents-plugin-openai';
import * as silero from '@livekit/agents-plugin-silero';
import { fileURLToPath } from 'node:url';

function createRawFunctionAgent() {
  return new voice.Agent({
    instructions: 'You are a helpful assistant.',
    tools: {
      openGate: llm.tool({
        description: 'Opens a specified gate from a predefined set of access points.',
        parameters: {
          type: 'object',
          properties: {
            gateId: {
              type: 'string',
              description: 'The ID of the gate to open',
              enum: [
                'main_entrance',
                'north_parking',
                'loading_dock',
                'side_gate',
                'service_entry',
              ],
            },
          },
          required: ['gateId'],
          additionalProperties: false,
        },
        execute: async ({ gateId }) => {
          return `The gate ${gateId} is now open.`;
        },
      }),
    },
  });
}

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load();
  },
  entry: async (ctx: JobContext) => {
    const vad = ctx.proc.userData.vad! as silero.VAD;

    const session = new voice.AgentSession({
      vad,
      stt: new deepgram.STT({
        sampleRate: 24000,
      }),
      tts: new elevenlabs.TTS(),
      llm: new openai.LLM(),
      // to use realtime model, replace the stt, llm, tts and vad with the following
      // llm: new openai.realtime.RealtimeModel(),
      userData: { number: 0 },
      turnDetection: new livekit.turnDetector.EnglishModel(),
    });

    await session.start({
      agent: createRawFunctionAgent(),
      room: ctx.room,
    });
  },
});

cli.runApp(new WorkerOptions({ agent: fileURLToPath(import.meta.url) }));
