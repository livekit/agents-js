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
import * as livekit from '@livekit/agents-plugin-livekit';
import * as silero from '@livekit/agents-plugin-silero';
import { BackgroundVoiceCancellation } from '@livekit/noise-cancellation-node';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load();
  },
  entry: async (ctx: JobContext) => {
    const agent = new voice.Agent({
      instructions:
        "You are a helpful assistant, you can hear the user's message and respond to it, end the call when the user asks you to.",
      tools: {
        getWeather: llm.tool({
          description: 'Get the weather for a given location.',
          parameters: z.object({
            location: z.string().describe('The location to get the weather for'),
          }),
          execute: async ({ location }) => {
            return `The weather in ${location} is sunny.`;
          },
        }),
        endCall: llm.tool({
          description: 'End the call.',
          parameters: z.object({
            reason: z
              .enum([
                'assistant-ended-call',
                'sip-call-transferred',
                'user-ended-call',
                'unknown-error',
              ])
              .describe('The reason to end the call'),
          }),
          execute: async ({ reason }, { ctx }) => {
            session.generateReply({
              userInput: `You are about to end the call due to ${reason}, notify the user with one last message`,
            });
            await ctx.waitForPlayout();

            session.shutdown({ reason });
          },
        }),
      },
    });

    const session = new voice.AgentSession({
      stt: 'assemblyai/universal-streaming:en',
      llm: 'openai/gpt-4.1-mini',
      tts: 'cartesia/sonic-2:9626c31c-bec5-4cca-baa8-f8ba9e84c8bc',
      vad: ctx.proc.userData.vad! as silero.VAD,
      turnDetection: new livekit.turnDetector.MultilingualModel(),
      voiceOptions: {
        preemptiveGeneration: true,
      },
    });

    // Track the session close reason
    session.on(voice.AgentSessionEventTypes.Close, ({ reason }) => {
      console.log(`[Voice Session Closed] Reason: ${reason}`);
    });

    await session.start({
      agent,
      room: ctx.room,
      inputOptions: {
        noiseCancellation: BackgroundVoiceCancellation(),
      },
    });

    session.say('Hello, how can I help you today?');
  },
});

cli.runApp(new WorkerOptions({ agent: fileURLToPath(import.meta.url) }));
