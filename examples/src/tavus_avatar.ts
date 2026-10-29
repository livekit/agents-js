// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type JobContext,
  ServerOptions,
  cli,
  defineAgent,
  inference,
  initializeLogger,
  llm,
  log,
  voice,
} from '@livekit/agents';
import * as tavus from '@livekit/agents-plugin-tavus';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

initializeLogger({ pretty: true });

export default defineAgent({
  entry: async (ctx: JobContext) => {
    const logger = log();
    const session = new voice.AgentSession({
      stt: new inference.STT({ model: 'deepgram/nova-3' }),
      llm: new inference.LLM({ model: 'google/gemini-2.5-flash' }),
      tts: new inference.TTS({ model: 'cartesia/sonic-3' }),
    });

    // faceId / palId fall back to TAVUS_FACE_ID / TAVUS_PAL_ID, then to the stock pal
    const avatar = new tavus.AvatarSession();
    await ctx.connect();
    await avatar.start(session, ctx.room);
    await avatar.waitForJoin();

    const setEmotion = llm.tool({
      description: 'Set the facial emotion of your avatar. It stays until you set another one.',
      parameters: z.object({ emotion: z.enum(tavus.EMOTIONS) }),
      execute: async ({ emotion }) => {
        logger.info({ emotion }, 'setting avatar emotion');
        await avatar.setEmotion(emotion);
        return `emotion set to ${emotion}`;
      },
    });

    const agent = new voice.Agent({
      instructions:
        "You're a warm, expressive assistant talking to the user over video. " +
        'Keep replies short and conversational, with no markdown. ' +
        'Your face can show emotion: whenever the mood of the conversation changes, ' +
        'call setEmotion to match it, for example happiness when something good happens ' +
        'or sadness when the user shares bad news.',
      tools: { setEmotion },
    });

    await session.start({ agent, room: ctx.room });
    session.generateReply({ instructions: 'Greet the user with a single short, happy line.' });
  },
});

cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url) }));
