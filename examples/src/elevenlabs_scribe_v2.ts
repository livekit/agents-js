// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
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
import * as elevenlabs from '@livekit/agents-plugin-elevenlabs';
import { fileURLToPath } from 'node:url';

export default defineAgent({
  entry: async (ctx: JobContext) => {
    const stt = new elevenlabs.STT({
      useRealtime: true,
      serverVad: {
        vadSilenceThresholdSecs: 0.5,
        vadThreshold: 0.5,
        minSpeechDurationMs: 100,
        minSilenceDurationMs: 300,
      },
      model: 'scribe_v2_realtime',
    });

    const session = new voice.AgentSession({
      voiceOptions: { allowInterruptions: true },
      stt,
      llm: new inference.LLM({ model: 'openai/gpt-4.1-mini' }),
      tts: new inference.TTS({ model: 'cartesia/sonic-3' }),
    });

    await session.start({
      agent: new voice.Agent({ instructions: 'You are a somewhat helpful assistant.' }),
      room: ctx.room,
    });

    session.say('Hello, how can I help you?', { allowInterruptions: false });
  },
});

cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url) }));
