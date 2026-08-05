// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  Agent,
  AgentSession,
  AgentSessionEventTypes,
  type JobContext,
  ServerOptions,
  cli,
  defineAgent,
  inference,
  log,
  logMetrics,
  tool,
} from '@livekit/agents';
import * as krisp from '@livekit/agents-plugin-krisp';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

// No prewarm hook needed: the local EOT model runs in the shared inference
// process (loaded once per host), and the silero VAD (~2MB, in-process)
// lazy-loads on first stream.
export default defineAgent({
  entry: async (ctx: JobContext) => {
    const agent = Agent.create({
      instructions:
        "You are a helpful assistant, you can hear the user's message and respond to it.",
      tools: [
        tool({
          name: 'getWeather',
          description: 'Get the weather for a given location.',
          parameters: z.object({
            location: z.string().describe('The location to get the weather for'),
          }),
          execute: async ({ location }) => {
            return `The weather in ${location} is sunny.`;
          },
        }),
      ],
    });

    const logger = log();

    const session = new AgentSession({
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
      ttsTextTransforms: ['filter_markdown', 'filter_emoji'],
      turnHandling: {
        // turn detection defaults to the audio inference.TurnDetector when unset.
        // See https://docs.livekit.io/agents/build/turns
        interruption: {
          // Enable false-interruption auto-resume behavior.
          resumeFalseInterruption: true,
          falseInterruptionTimeout: 1000,
          mode: 'adaptive',
        },
        // Dynamic endpointing learns the user's pause rhythm and adapts the short/long waits
        // used before committing a user turn.
        endpointing: {
          mode: 'dynamic',
          minDelay: 300,
          maxDelay: 3000,
        },
        // Preemptive generation speculatively starts LLM inference while the user is still
        // speaking to reduce time-to-first-token. See PreemptiveGenerationOptions for all
        // tunables (enabled, preemptiveTts, maxSpeechDuration, maxRetries).
        preemptiveGeneration: {
          enabled: true,
        },
      },
      // automatically detect keyterms and apply them to the STT per user turn
      sttContextOptions: {
        keyterms: ['LiveKit'],
        keytermDetection: {
          enabled: true,
          turnInterval: 1, // increase to reduce LLM API calls
        },
      },
      useTtsAlignedTranscript: true,
      aecWarmupDuration: 3000,
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
    session.on(AgentSessionEventTypes.MetricsCollected, (ev) => {
      if (ev.metrics.type === 'stt_metrics') {
        return;
      }
      logMetrics(ev.metrics);
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

    session.on(AgentSessionEventTypes.OverlappingSpeech, (ev) => {
      logger.warn({ type: ev.type, isInterruption: ev.isInterruption }, 'user overlapping speech');
    });

    await session.start({
      agent,
      room: ctx.room,
      inputOptions: {
        deleteRoomOnClose: true,
        noiseCancellation: krisp.voiceIsolation(),
      },
    });

    session.say('Hello, how can I help you today?');
  },
});

cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url) }));
