// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { type JobContext, ServerOptions, cli, defineAgent, voice } from '@livekit/agents';
import * as addisai from '@livekit/agents-plugin-addisai';
import { fileURLToPath } from 'node:url';

export default defineAgent({
  entry: async (ctx: JobContext) => {
    const session = new voice.AgentSession({
      // AddisAI STT is batch-only. AgentSession's bundled VAD adapts it to
      // conversational turns without requiring a separate turn detector.
      stt: new addisai.STT({ language: 'am' }),
      llm: 'google/gemini-3.5-flash',
      tts: new addisai.TTS({
        language: 'am',
        voice: 'am-hamen',
      }),
    });

    await session.start({
      agent: new voice.Agent({
        instructions: 'You are a helpful voice assistant. Reply briefly in Amharic.',
      }),
      room: ctx.room,
    });

    session.say('ሰላም፣ እንዴት ልርዳዎ?');
  },
});

cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url) }));
