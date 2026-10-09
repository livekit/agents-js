// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { ServerOptions, cli, defineAgent, inference, voice } from '@livekit/agents';
import * as spatius from '@livekit/agents-plugin-spatius';
import { fileURLToPath } from 'node:url';

export default defineAgent({
  prewarm: spatius.prewarm,
  entry: async (ctx) => {
    const session = new voice.AgentSession({
      stt: new inference.STT({ model: 'deepgram/nova-3', language: 'en' }),
      llm: new inference.LLM({ model: 'openai/gpt-4.1-mini' }),
      tts: new inference.TTS({
        model: 'cartesia/sonic-3',
        voice: '9626c31c-bec5-4cca-baa8-f8ba9e84c8bc',
      }),
    });

    await ctx.connect();
    const avatar = new spatius.AvatarSession();
    await avatar.start(session, ctx.room);
    await session.start({
      agent: new voice.Agent({
        instructions: 'You are a friendly avatar assistant. Keep your responses concise.',
      }),
      room: ctx.room,
    });
    await ctx.waitForParticipant();
    session.generateReply({ instructions: 'Greet the user and ask how you can help.' });
  },
});

cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url) }));
