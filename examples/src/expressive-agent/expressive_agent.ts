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
} from '@livekit/agents';
import { fileURLToPath } from 'node:url';
import { GREETING, INSTRUCTIONS } from './prompt.js';

class Friend extends Agent {
  constructor() {
    super({ instructions: INSTRUCTIONS });
  }

  async onEnter(): Promise<void> {
    this.session.generateReply({ instructions: GREETING });
  }
}

export default defineAgent({
  entry: async (ctx: JobContext) => {
    const session = new AgentSession({
      stt: new inference.STT({ model: 'assemblyai/universal-streaming', language: 'en' }),
      llm: new inference.LLM({ model: 'google/gemini-2.5-flash' }),
      tts: new inference.TTS({
        model: 'fishaudio/s2.1-pro',
        voice: '51b44863613e405a896f7f4294c6e6d0',
      }),
      turnHandling: {
        turnDetection: new inference.TurnDetector(),
        interruption: { mode: 'adaptive' },
        preemptiveGeneration: { enabled: true },
      },
      // The single flag. With it enabled the framework injects the TTS provider's markup
      // guide into the LLM prompt, so the model emits inline delivery tags (emotion,
      // pacing, non-verbal sounds) that the TTS renders and the transcript never shows.
      // Flip it to false and say the same things again — the words come out much the
      // same; the delivery does not.
      expressive: true,
    });

    await session.start({ agent: new Friend(), room: ctx.room });
  },
});

cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url) }));
