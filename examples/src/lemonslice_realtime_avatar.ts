// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type JobContext,
  type JobProcess,
  ServerOptions,
  cli,
  defineAgent,
  inference,
  initializeLogger,
  voice,
} from '@livekit/agents';
import * as lemonslice from '@livekit/agents-plugin-lemonslice';
import * as livekit from '@livekit/agents-plugin-livekit';
import * as silero from '@livekit/agents-plugin-silero';
import { fileURLToPath } from 'node:url';

initializeLogger({ pretty: true });

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load();
  },
  entry: async (ctx: JobContext) => {
    try {
      const agent = new voice.Agent({
        instructions: 'You are a helpful assistant. Speak clearly and concisely.',
      });

      const session = new voice.AgentSession({
        stt: new inference.STT({
          model: 'assemblyai/universal-streaming',
          language: 'en',
        }),
        llm: new inference.LLM({
          model: 'openai/gpt-4.1-mini',
        }),
        tts: new inference.TTS({
          model: 'cartesia/sonic-3',
          voice: '9626c31c-bec5-4cca-baa8-f8ba9e84c8bc',
        }),
        turnDetection: new livekit.turnDetector.MultilingualModel(),
        vad: ctx.proc.userData.vad! as silero.VAD,
        voiceOptions: {
          preemptiveGeneration: true,
        },
      });

      await session.start({
        agent,
        room: ctx.room,
        outputOptions: {
          syncTranscription: false,
        },
      });

      const agentImageUrl = process.env.LEMONSLICE_IMAGE_URL;
      if (!agentImageUrl) {
        throw new Error('LEMONSLICE_IMAGE_URL is required');
      }

      // Add the LemonSlice avatar to the session
      const avatar = new lemonslice.AvatarSession({
        agentImageUrl: agentImageUrl,
        agentPrompt: 'Be expressive in your movements and use your hands while talking.',
      });
      await avatar.start(session, ctx.room);

      session.generateReply({
        instructions: 'Greet the user briefly and confirm you are ready.',
      });

      await ctx.connect();
    } catch (error) {
      console.error('Error in LemonSlice agent:', error);
      throw error;
    }
  },
});

cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url) }));
