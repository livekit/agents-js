// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Microsoft AI STT/TTS with an existing OpenAI LLM and local Silero VAD.
 *
 * Set MICROSOFT_AI_ENV_FILE to an explicit local dotenv file, or set the
 * MICROSOFT_AI_* variables documented in the plugin README, plus
 * OPENAI_API_KEY for the LLM. Confirm the provisional endpoint contracts first.
 * The CLI's console mode works without LiveKit Cloud.
 */
import {
  type JobContext,
  ServerOptions,
  cli,
  defineAgent,
  inference,
  voice,
} from '@livekit/agents';
import * as microsoft from '@livekit/agents-plugin-microsoft';
import * as openai from '@livekit/agents-plugin-openai';
import { fileURLToPath, pathToFileURL } from 'node:url';

export default defineAgent({
  entry: async (ctx: JobContext) => {
    const detector = new inference.VAD({ model: 'silero' });
    const speechToText = new microsoft.STT({ vad: detector });
    const textToSpeech = new microsoft.TTS();
    ctx.addShutdownCallback(() => speechToText.close());
    ctx.addShutdownCallback(() => textToSpeech.close());

    const session = new voice.AgentSession({
      vad: detector,
      stt: speechToText,
      llm: new openai.LLM({ model: process.env.OPENAI_MODEL ?? 'gpt-4.1-mini' }),
      // The default agent TTS node supplies the sentence StreamAdapter.
      tts: textToSpeech,
    });
    await session.start({
      room: ctx.room,
      agent: new voice.Agent({
        instructions: 'You are a helpful voice assistant. Keep your replies concise.',
      }),
    });
    session.generateReply({ instructions: 'Greet the user briefly.' });
  },
});

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url) }));
}
