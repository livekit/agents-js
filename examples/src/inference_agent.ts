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
import * as silero from '@livekit/agents-plugin-silero';
import { fileURLToPath } from 'node:url';

const DEFAULT_STT = 'deepgram/nova-3';
const DEFAULT_LLM = 'openai/gpt-4o-mini';
const DEFAULT_TTS = 'cartesia/sonic-2';

const INSTRUCTIONS =
  "You're a friendly demo agent showcasing LiveKit Inference. " +
  'Keep replies short, natural, and conversational. If asked which models you are using, ' +
  'answer honestly because they swap live as the user picks new ones in the playground.';

function swapPrompt(modality: string, model: string): string {
  return (
    `The user just switched the ${modality} model to '${model}'. ` +
    "Acknowledge it in one short, natural sentence. Say the model's name like a brand " +
    "and skip hyphens, slashes, version dots, and abbreviations that aren't pronounceable. " +
    "Don't ask a follow-up."
  );
}

function parseValue(payload: string, fallback: string): string {
  try {
    const value = (JSON.parse(payload) as { value?: unknown }).value;
    return typeof value === 'string' && value.length > 0 ? value : fallback;
  } catch {
    return fallback;
  }
}

class InferenceAgent extends voice.Agent {
  constructor() {
    super({ instructions: INSTRUCTIONS });
  }
}

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load();
  },
  entry: async (ctx: JobContext) => {
    const session = new voice.AgentSession({
      vad: ctx.proc.userData.vad! as silero.VAD,
      stt: new inference.STT({ model: DEFAULT_STT }),
      llm: new inference.LLM({ model: DEFAULT_LLM }),
      tts: new inference.TTS({ model: DEFAULT_TTS }),
    });

    await session.start({ agent: new InferenceAgent(), room: ctx.room });

    ctx.room.localParticipant?.registerRpcMethod('set_stt_model', async (data) => {
      const model = parseValue(data.payload, DEFAULT_STT);
      if (session.stt instanceof inference.STT && session.stt.model === model) {
        return '';
      }
      if (session.stt instanceof inference.STT) {
        session.stt.updateOptions({ model });
      }
      void session.generateReply({ instructions: swapPrompt('speech-to-text', model) });
      return '';
    });

    ctx.room.localParticipant?.registerRpcMethod('set_llm_model', async (data) => {
      const model = parseValue(data.payload, DEFAULT_LLM);
      if (session.llm instanceof inference.LLM && session.llm.model === model) {
        return '';
      }
      session.llm = new inference.LLM({ model });
      void session.generateReply({ instructions: swapPrompt('language', model) });
      return '';
    });

    ctx.room.localParticipant?.registerRpcMethod('set_tts_model', async (data) => {
      const model = parseValue(data.payload, DEFAULT_TTS);
      if (session.tts instanceof inference.TTS && session.tts.model === model) {
        return '';
      }
      if (session.tts instanceof inference.TTS) {
        session.tts.updateOptions({ model });
      }
      void session.generateReply({ instructions: swapPrompt('text-to-speech', model) });
      return '';
    });
  },
});

cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url) }));
