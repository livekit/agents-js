// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
//
// Requires a .env at the repo root with LIVEKIT_URL, LIVEKIT_API_KEY,
// LIVEKIT_API_SECRET, and OPENAI_API_KEY.
//
// Run: pnpm build && node --env-file=.env ./examples/src/realtime_streaming_transcript.ts dev
import { type JobContext, ServerOptions, cli, defineAgent, log, voice } from '@livekit/agents';
import * as openai from '@livekit/agents-plugin-openai';
import { fileURLToPath } from 'node:url';

export default defineAgent({
  entry: async (ctx: JobContext) => {
    const logger = log();
    await ctx.connect();

    const session = new voice.AgentSession({
      llm: new openai.realtime.RealtimeModel({
        inputAudioTranscription: { model: 'gpt-realtime-whisper' },
      }),
    });

    let lastPartialLength = 0;
    session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (ev) => {
      if (ev.isFinal) {
        logger.info({ 'lk.pii.transcript': ev.transcript }, 'user transcript final');
        lastPartialLength = 0;
        return;
      }
      if (ev.transcript.length - lastPartialLength >= 6) {
        logger.info({ 'lk.pii.transcript': ev.transcript }, 'user transcript partial');
        lastPartialLength = ev.transcript.length;
      }
    });

    await session.start({
      agent: new voice.Agent({
        instructions:
          'You are a helpful assistant for a streaming-transcript demo. ' +
          'Keep every reply to one short sentence so the user stays the focus. ' +
          'Ask the user to read a long sentence or two aloud so they can see their own words streaming live.',
      }),
      room: ctx.room,
    });

    session.generateReply({
      instructions:
        'Greet the user briefly and ask them to say a long sentence so they can watch their own words appear live on screen as they speak.',
    });
  },
});

cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url) }));
