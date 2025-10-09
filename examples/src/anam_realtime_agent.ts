// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type JobContext,
  type JobProcess,
  WorkerOptions,
  cli,
  defineAgent,
  voice,
} from '@livekit/agents';
import * as anam from '@livekit/agents-plugin-anam';
import * as deepgram from '@livekit/agents-plugin-deepgram';
import * as elevenlabs from '@livekit/agents-plugin-elevenlabs';
import * as livekit from '@livekit/agents-plugin-livekit';
import * as openai from '@livekit/agents-plugin-openai';
import * as silero from '@livekit/agents-plugin-silero';
import { fileURLToPath } from 'node:url';

// Uses OpenAI Advanced Voice (Realtime), so no separate STT/TTS/VAD.

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load();
  },
  entry: async (ctx: JobContext) => {
    const agent = new voice.Agent({
      instructions: 'You are a helpful assistant. Speak clearly and concisely.',
    });

    const session = new voice.AgentSession({
      vad: ctx.proc.userData.vad! as silero.VAD,
      stt: new deepgram.STT(),
      tts: new elevenlabs.TTS(),
      // To use OpenAI Realtime API
      llm: new openai.realtime.RealtimeModel({
        voice: 'alloy',
        // it's necessary to turn off turn detection in the OpenAI Realtime API in order to use
        // LiveKit's turn detection model
        turnDetection: null,
        inputAudioTranscription: null,
      }),
      turnDetection: new livekit.turnDetector.EnglishModel(),
    });

    await session.start({
      agent,
      room: ctx.room,
      // TODO: transcription is not sync yet, will work on a proper fix for it later
      outputOptions: {
        syncTranscription: false,
      },
    });

    // Join the LiveKit room first (ensures room name and identity available)
    await ctx.connect();

    // Configure the Anam avatar persona (requires avatarId)
    const personaName = process.env.ANAM_PERSONA_NAME ?? 'Agent';
    const avatarId = process.env.ANAM_AVATAR_ID;
    if (!avatarId) {
      throw new Error('ANAM_AVATAR_ID is required');
    }

    // Start the Anam avatar session and route Agent audio to the avatar
    const avatar = new anam.AvatarSession({
      personaConfig: { name: personaName, avatarId },
      apiUrl: process.env.ANAM_API_URL,
    });
    await avatar.start(session, ctx.room);

    // With Realtime LLM, generateReply will synthesize audio via the model
    session.generateReply({
      instructions: 'Greet the user briefly and confirm you are ready.',
    });
  },
});

cli.runApp(new WorkerOptions({ agent: fileURLToPath(import.meta.url) }));
