// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type JobContext,
  type JobProcess,
  ServerOptions,
  cli,
  defineAgent,
  inference,
  voice,
} from '@livekit/agents';
import * as elevenlabs from '@livekit/agents-plugin-elevenlabs';
import * as silero from '@livekit/agents-plugin-silero';
import { fileURLToPath } from 'node:url';

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load();
  },
  entry: async (ctx: JobContext) => {
    const stt = new elevenlabs.STT({
      useRealtime: true,
      serverVad: {
        vadSilenceThresholdSecs: 0.5,
        vadThreshold: 0.5,
        minSpeechDurationMs: 100,
        minSilenceDurationMs: 300,
      },
      modelId: 'scribe_v2_realtime',
    });

    const session = new voice.AgentSession({
      voiceOptions: { allowInterruptions: true },
      vad: ctx.proc.userData.vad! as silero.VAD,
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
