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
import * as openai from '@livekit/agents-plugin-openai';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

// The default VAD lazy-loads on first stream.
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
      llm: new openai.realtime.RealtimeModel({
        model: 'gpt-realtime',
        // LiveKit must own turn commits for adaptive interruption to work.
        turnDetection: null,
      }),
      turnHandling: {
        turnDetection: new inference.TurnDetector(),
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
      },
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

    session.generateReply({ instructions: 'Greet the user and offer your assistance.' });
  },
});

cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url) }));
