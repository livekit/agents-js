// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { type JobContext, ServerOptions, cli, defineAgent, voice } from '@livekit/agents';
import * as deepgram from '@livekit/agents-plugin-deepgram';
import * as google from '@livekit/agents-plugin-google';
import { BackgroundVoiceCancellation } from '@livekit/noise-cancellation-node';
import { fileURLToPath } from 'node:url';

class GeminiTTSAgent extends voice.Agent {
  async onEnter() {
    this.session.generateReply({ instructions: 'greet the user and introduce yourself' });
  }
}

export default defineAgent({
  entry: async (ctx: JobContext) => {
    const agent = new GeminiTTSAgent({
      instructions: 'Your name is Kelly. Respond briefly and concisely using voice conversation.',
    });

    const session = new voice.AgentSession({
      stt: new deepgram.STT(),
      llm: new google.LLM({ model: 'gemini-2.5-flash' }),
      tts: new google.beta.TTS({
        apiKey: process.env.GOOGLE_API_KEY,
        voiceName: 'Kore',
        model: 'gemini-3.1-flash-tts-preview',
      }),
    });

    await session.start({
      agent,
      room: ctx.room,
      inputOptions: {
        noiseCancellation: BackgroundVoiceCancellation(),
      },
    });
  },
});

cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url) }));
