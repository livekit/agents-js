// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * This example demonstrates the usage of the LLM FallbackAdapter.
 *
 * The FallbackAdapter allows you to configure multiple LLM providers and
 * automatically fall back to the next provider if the current one fails.
 * This improves reliability by ensuring your voice agent continues to work
 * even if one LLM provider experiences downtime or errors.
 *
 * Key features:
 * - Automatic failover between LLM providers
 * - Background health recovery checks for failed providers
 * - Configurable timeouts and retry behavior
 * - Event emission when provider availability changes
 */
import {
  type JobContext,
  type JobProcess,
  ServerOptions,
  cli,
  defineAgent,
  llm,
  voice,
} from '@livekit/agents';
import * as deepgram from '@livekit/agents-plugin-deepgram';
import * as elevenlabs from '@livekit/agents-plugin-elevenlabs';
import * as openai from '@livekit/agents-plugin-openai';
import * as silero from '@livekit/agents-plugin-silero';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load();
  },
  entry: async (ctx: JobContext) => {
    // Create multiple LLM instances for fallback
    // The FallbackAdapter will try them in order: primary -> secondary -> tertiary
    const primaryLLM = new openai.LLM({ model: 'gpt-4o' });
    const secondaryLLM = new openai.LLM({ model: 'gpt-4o-mini' });
    // You can mix different providers as well:
    // const tertiaryLLM = new anthropic.LLM({ model: 'claude-3-5-sonnet' });

    // Create the FallbackAdapter with your LLM instances
    const fallbackLLM = new llm.FallbackAdapter({
      llms: [primaryLLM, secondaryLLM],
      // Optional configuration:
      attemptTimeout: 10.0, // Timeout for each LLM attempt in seconds (default: 5.0)
      maxRetryPerLLM: 1, // Number of retries per LLM before moving to next (default: 0)
      retryInterval: 0.5, // Interval between retries in seconds (default: 0.5)
      retryOnChunkSent: false, // Whether to retry if chunks were already sent (default: false)
    });

    // Listen for availability change events
    // Note: Using type assertion since FallbackAdapter extends LLM but has additional events
    (fallbackLLM as llm.FallbackAdapter).on(
      'llm_availability_changed' as 'metrics_collected',
      (event: unknown) => {
        const e = event as llm.AvailabilityChangedEvent;
        if (e.available) {
          console.log(`LLM ${e.llm.label()} recovered and is now available`);
        } else {
          console.log(`LLM ${e.llm.label()} failed and is now unavailable`);
        }
      },
    );

    const agent = new voice.Agent({
      instructions:
        'You are a helpful assistant. Demonstrate that you are working by responding to user queries.',
      tools: {
        getWeather: llm.tool({
          description: 'Get the weather for a given location.',
          parameters: z.object({
            location: z.string().describe('The location to get the weather for'),
          }),
          execute: async ({ location }) => {
            return `The weather in ${location} is sunny with a temperature of 72°F.`;
          },
        }),
      },
    });

    const session = new voice.AgentSession({
      vad: ctx.proc.userData.vad! as silero.VAD,
      stt: new deepgram.STT(),
      tts: new elevenlabs.TTS(),
      llm: fallbackLLM, // Use the FallbackAdapter instead of a single LLM
    });

    await session.start({
      agent,
      room: ctx.room,
    });

    session.say('Hello! I am a voice agent with LLM fallback support. How can I help you today?');

    const participant = await ctx.waitForParticipant();
    console.log('Participant joined:', participant.identity);
  },
});

cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url) }));
