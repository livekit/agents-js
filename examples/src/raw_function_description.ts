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
  voice,
} from '@livekit/agents';
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
  entry: async (ctx: JobContext) => {
    const session = new voice.AgentSession({
      stt: new inference.STT({
        model: 'deepgram/nova-3',
        language: 'en',
      }),
      tts: new inference.TTS({
        model: 'cartesia/sonic-3',
        voice: '9626c31c-bec5-4cca-baa8-f8ba9e84c8bc',
      }),
      llm: new inference.LLM({ model: 'openai/gpt-4.1-mini' }),
      // to use realtime model, replace the stt, llm, tts and vad with the following
      // llm: new openai.realtime.RealtimeModel(),
      userData: { number: 0 },
    });

    await session.start({
      agent: createRawFunctionAgent(),
      room: ctx.room,
    });
  },
});

cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url) }));
