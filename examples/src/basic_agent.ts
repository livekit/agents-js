// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type JobContext,
  type JobProcess,
  WorkerOptions,
  cli,
  defineAgent,
  inference,
  llm,
  log,
  metrics,
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
        "You are a helpful assistant, you can hear the user's message and respond to it.",
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
      },
    });

    const logger = log();

    const session = new voice.AgentSession({
      // Speech-to-text (STT) is your agent's ears, turning the user's speech into text that the LLM can understand
      // See all available models at https://docs.livekit.io/agents/models/stt/
      stt: new inference.STT({
        model: 'deepgram/nova-3',
        language: 'en',
        fallback: ['assemblyai/universal-streaming', 'cartesia/ink-whisper'],
      }),
      // A Large Language Model (LLM) is your agent's brain, processing user input and generating a response
      // See all available models at https://docs.livekit.io/agents/models/llm/
      // llm: new inference.LLM({ model: 'openai/gpt-4.1-mini' }),
      llm: new inference.LLM({ model: 'openai/gpt-4.1-mini' }),
      // Text-to-speech (TTS) is your agent's voice, turning the LLM's text into speech that the user can hear
      // See all available models as well as voice selections at https://docs.livekit.io/agents/models/tts/
      tts: new inference.TTS({
        model: 'cartesia/sonic-3',
        voice: '9626c31c-bec5-4cca-baa8-f8ba9e84c8bc',
        fallback: [
          { model: 'elevenlabs/eleven_flash_v2', voice: '9626c31c-bec5-4cca-baa8-f8ba9e84c8bc' },
          'rime/arcana',
        ],
      }),
      // VAD and turn detection are used to determine when the user is speaking and when the agent should respond
      // See more at https://docs.livekit.io/agents/build/turns
      vad: ctx.proc.userData.vad! as silero.VAD,

      // to use realtime model, replace the stt, llm, tts and vad with the following
      // llm: new openai.realtime.RealtimeModel(),
      options: {
        // allow the LLM to generate a response while waiting for the end of turn
        preemptiveGeneration: true,
        turnHandling: {
          turnDetection: new livekit.turnDetector.MultilingualModel(),
          interruption: {
            resumeFalseInterruption: true,
            falseInterruptionTimeout: 1,
            mode: 'adaptive',
          },
        },
        useTtsAlignedTranscript: true,
      },
      connOptions: {
        // Example of overriding the default connection options for the LLM/TTS/STT
        llmConnOptions: {
          maxRetry: 1,
          retryIntervalMs: 2000,
          timeoutMs: 60000,
        },
      },
    });

    // Log metrics as they are emitted
    session.on(voice.AgentSessionEventTypes.MetricsCollected, (ev) => {
      metrics.logMetrics(ev.metrics);
    });

    // Log usage summary when job shuts down
    ctx.addShutdownCallback(async () => {
      logger.info(
        {
          usage: session.usage,
        },
        'Session usage summary',
      );
    });

    session.on(voice.AgentSessionEventTypes.UserInterruptionDetected, (ev) => {
      logger.warn({ type: ev.type }, 'interruption detected');
    });

    session.on(voice.AgentSessionEventTypes.UserNonInterruptionDetected, (ev) => {
      logger.warn({ type: ev.type }, 'non interruption detected');
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
