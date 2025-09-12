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
import * as deepgram from '@livekit/agents-plugin-deepgram';
import * as elevenlabs from '@livekit/agents-plugin-elevenlabs';
import * as livekit from '@livekit/agents-plugin-livekit';
import * as openai from '@livekit/agents-plugin-openai';
import * as silero from '@livekit/agents-plugin-silero';
import { fileURLToPath } from 'node:url';

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load();
  },
  entry: async (ctx: JobContext) => {
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
      agent: new voice.Agent({
        instructions:
          "You are a helpful assistant, you can hear the user's message and respond to it.",
      }),
      room: ctx.room,
    });

    session.say('Hello, how can I help you today?');
  },
});

cli.runApp(new WorkerOptions({ agent: fileURLToPath(import.meta.url) }));
