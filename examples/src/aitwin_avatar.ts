// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
/**
 * Ai Twin demo agent: STT + LLM only. Browser owns TTS + lipsync via speakText().
 *
 * Pair with a frontend that:
 * 1) connects to the LiveKit room
 * 2) registers a text-stream handler for `aitwin.speak` (or TOPIC_SPEAK)
 * 3) calls `@streamoji/aitwin` speakText() for each chunk
 *
 * Reference UI: https://github.com/aitwin-me/aitwin-livekit-demo
 */
import {
  type JobContext,
  type JobProcess,
  ServerOptions,
  cli,
  defineAgent,
  voice,
} from '@livekit/agents';
import { AiTwinSpeech } from '@livekit/agents-plugin-aitwin';
import * as openai from '@livekit/agents-plugin-openai';
import * as silero from '@livekit/agents-plugin-silero';
import { fileURLToPath } from 'node:url';

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load();
  },
  entry: async (ctx: JobContext) => {
    await ctx.connect();

    const vad = ctx.proc.userData.vad as silero.VAD;
    const agent = new voice.Agent({
      instructions:
        'You are a helpful assistant. Keep replies to 1-2 short sentences. ' +
        'Your words will be spoken by an Ai Twin avatar in the user browser.',
    });

    const session = new voice.AgentSession({
      vad,
      stt: new openai.STT({ model: process.env.STT_MODEL || 'gpt-4o-mini-transcribe' }),
      llm: new openai.LLM({ model: process.env.LLM_MODEL || 'gpt-4o-mini' }),
      // No agent TTS — Ai Twin owns voice in the browser via speakText().
    });

    const twinSpeech = new AiTwinSpeech({
      topic: process.env.TOPIC_SPEAK || 'aitwin.speak',
    });
    twinSpeech.start(session, ctx.room);

    await session.start({
      agent,
      room: ctx.room,
      outputOptions: {
        audioEnabled: false,
        transcriptionEnabled: false,
      },
    });

    await session.generateReply({
      instructions: 'Greet the user in one short friendly sentence.',
    });
  },
});

cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url) }));
