// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type JobContext,
  ServerOptions,
  cli,
  defineAgent,
  log,
  metrics,
  voice,
} from '@livekit/agents';
import * as aws from '@livekit/agents-plugin-aws';
import { fileURLToPath } from 'node:url';

// Demonstrates a fully AWS-backed voice pipeline: Amazon Transcribe (STT),
// Amazon Bedrock Converse (LLM), and Amazon Polly (TTS).
//
// Credentials are resolved via the AWS SDK v3 default credential chain
// (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN, a shared
// profile, IMDS, etc.) — see plugins/aws/README.md for details. The region
// defaults to AWS_REGION / AWS_DEFAULT_REGION / "us-east-1".
export default defineAgent({
  entry: async (ctx: JobContext) => {
    const agent = new voice.Agent({
      instructions:
        "You are a helpful assistant, you can hear the user's message and respond to it.",
    });

    const logger = log();

    const session = new voice.AgentSession({
      stt: new aws.STT({ language: 'en-US' }),
      llm: new aws.LLM({
        // model defaults to BEDROCK_INFERENCE_PROFILE_ARN if set, otherwise 'amazon.nova-2-lite-v1:0'
      }),
      // Amazon Polly only supports PCM output at 8000 or 16000 Hz.
      tts: new aws.TTS({ voice: 'Ruth', sampleRate: 16000 }),
      turnHandling: {
        turnDetection: 'stt',
      },
    });

    // Log metrics as they are emitted (session.usage is automatically collected)
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

    await session.start({
      agent,
      room: ctx.room,
    });

    session.say('Hello, how can I help you today?');
  },
});

cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url) }));
