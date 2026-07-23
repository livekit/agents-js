// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  Agent,
  AgentSession,
  type JobContext,
  ServerOptions,
  cli,
  defineAgent,
  inference,
  initializeLogger,
} from '@livekit/agents';
import { fileURLToPath } from 'node:url';

initializeLogger({ pretty: true });

export default defineAgent({
  entry: async (ctx: JobContext) => {
    const session = new AgentSession({
      stt: new inference.STT({ model: 'deepgram/nova-3' }),
      llm: new inference.LLM({ model: 'google/gemini-2.5-flash' }),
      tts: new inference.TTS({ model: 'cartesia/sonic-3' }),
    });

    // Avatar provisioning goes through LiveKit Inference: only LIVEKIT_API_KEY /
    // LIVEKIT_API_SECRET are needed (no provider key). The gateway creates the
    // LemonSlice session with LiveKit's wholesale key; media stays in-room.
    // Pass a catalog agent id instead of an image with model: 'lemonslice/<agent_id>'.
    const avatarImageUrl = process.env.LEMONSLICE_IMAGE_URL;
    if (!avatarImageUrl) {
      throw new Error('LEMONSLICE_IMAGE_URL must be set');
    }
    const avatar = new inference.AvatarSession({
      model: 'lemonslice',
      extraKwargs: {
        image_url: avatarImageUrl,
        prompt: 'Be expressive in your movements and use your hands while talking.',
      },
    });
    await avatar.start(session, ctx.room);
    await avatar.waitForJoin();

    await session.start({ agent: new Agent({ instructions: 'Talk to me!' }), room: ctx.room });
    session.generateReply({ instructions: 'say hello to the user' });
  },
});

cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url) }));
