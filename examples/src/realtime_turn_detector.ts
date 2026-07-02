// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type JobContext,
  ServerOptions,
  cli,
  defineAgent,
  inference,
  voice,
} from '@livekit/agents';
import * as deepgram from '@livekit/agents-plugin-deepgram';
import * as elevenlabs from '@livekit/agents-plugin-elevenlabs';
import * as openai from '@livekit/agents-plugin-openai';
import { fileURLToPath } from 'node:url';

export default defineAgent({
  entry: async (ctx: JobContext) => {
    const session = new voice.AgentSession({
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
      turnDetection: new inference.TurnDetector(),
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

cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url) }));
