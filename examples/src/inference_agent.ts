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
  llm,
  log,
  voice,
} from '@livekit/agents';
import * as silero from '@livekit/agents-plugin-silero';
import type { RpcInvocationData } from '@livekit/rtc-node';
import { fileURLToPath } from 'node:url';

const DEFAULT_STT = 'deepgram/nova-3';
const DEFAULT_LLM = 'openai/gpt-4.1-mini';
const DEFAULT_TTS = 'cartesia/sonic-3';

// Keep in sync with the `set_system_prompt` control's `default` in examples/playground.yaml.
const INSTRUCTIONS =
  "You're a friendly agent in the LiveKit Playground. The person talking to you is " +
  'prototyping their own voice agent — they can edit this prompt in the side panel and ' +
  'swap the STT / LLM / TTS models live. Keep replies short, natural, and conversational. ' +
  "If asked which models you're using, answer honestly.";

const SWAP_PROMPT =
  "The user just switched the {modality} model to '{model}'. Acknowledge it in one " +
  "short, natural sentence — say the model's name like a brand (e.g. 'Deepgram Nova 3', " +
  "not 'deepgram slash nova dash three'). Skip hyphens, slashes, version dots, and any " +
  "abbreviations that aren't pronounceable. Don't ask a follow-up.";

const INSTRUCTIONS_MESSAGE_ID = 'lk.agent_task.instructions';

class InferenceAgent extends voice.Agent {
  constructor(instructions: string = INSTRUCTIONS) {
    super({ instructions });
  }
}

function parseValue(payload: string, fallback: string): string {
  try {
    const value = (JSON.parse(payload) as { value?: unknown }).value;
    return typeof value === 'string' && value.length > 0 ? value : fallback;
  } catch {
    return fallback;
  }
}

function swapPrompt(modality: string, model: string): string {
  return SWAP_PROMPT.replace('{modality}', modality).replace('{model}', model);
}

function updateAgentInstructions(agent: InferenceAgent, instructions: string) {
  agent._instructions = instructions;

  const idx = agent._chatCtx.indexById(INSTRUCTIONS_MESSAGE_ID);
  if (idx !== undefined) {
    agent._chatCtx.items[idx] = llm.ChatMessage.create({
      id: INSTRUCTIONS_MESSAGE_ID,
      role: 'system',
      content: [instructions],
      createdAt: agent._chatCtx.items[idx]!.createdAt,
    });
  } else {
    agent._chatCtx.items.unshift(
      llm.ChatMessage.create({
        id: INSTRUCTIONS_MESSAGE_ID,
        role: 'system',
        content: [instructions],
      }),
    );
  }
}

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load();
  },
  entry: async (ctx: JobContext) => {
    const logger = log();
    const agent = new InferenceAgent();

    const session = new voice.AgentSession({
      vad: ctx.proc.userData.vad! as silero.VAD,
      stt: new inference.STT({ model: DEFAULT_STT }),
      llm: new inference.LLM({ model: DEFAULT_LLM }),
      tts: new inference.TTS({ model: DEFAULT_TTS }),
    });

    await session.start({
      agent,
      room: ctx.room,
    });

    ctx.room.localParticipant?.registerRpcMethod(
      'set_stt_model',
      async (data: RpcInvocationData) => {
        const model = parseValue(data.payload, DEFAULT_STT);
        if (session.stt instanceof inference.STT && session.stt.model === model) {
          return '';
        }
        logger.info({ model }, 'switching STT model');
        if (session.stt instanceof inference.STT) {
          session.stt.updateOptions({ model });
        }
        session.generateReply({ instructions: swapPrompt('speech-to-text', model) });
        return '';
      },
    );

    ctx.room.localParticipant?.registerRpcMethod(
      'set_llm_model',
      async (data: RpcInvocationData) => {
        const model = parseValue(data.payload, DEFAULT_LLM);
        if (session.llm instanceof inference.LLM && session.llm.model === model) {
          return '';
        }
        logger.info({ model }, 'switching LLM model');
        if (session.llm instanceof inference.LLM) {
          session.llm.updateOptions({ model });
        }
        session.generateReply({ instructions: swapPrompt('language', model) });
        return '';
      },
    );

    ctx.room.localParticipant?.registerRpcMethod(
      'set_tts_model',
      async (data: RpcInvocationData) => {
        const model = parseValue(data.payload, DEFAULT_TTS);
        if (session.tts instanceof inference.TTS && session.tts.model === model) {
          return '';
        }
        logger.info({ model }, 'switching TTS model');
        if (session.tts instanceof inference.TTS) {
          session.tts.updateOptions({ model });
        }
        session.generateReply({ instructions: swapPrompt('text-to-speech', model) });
        return '';
      },
    );

    ctx.room.localParticipant?.registerRpcMethod('open_in_builder', async () => {
      const params = new URLSearchParams({
        modelMode: 'pipeline',
        instructions: String(agent.instructions ?? ''),
        llm: session.llm instanceof inference.LLM ? session.llm.model : DEFAULT_LLM,
        stt: session.stt instanceof inference.STT ? session.stt.model : DEFAULT_STT,
        tts: session.tts instanceof inference.TTS ? session.tts.model : DEFAULT_TTS,
      });

      return `https://cloud.livekit.io/projects/p_/agents/builder/new?${params.toString()}`;
    });

    ctx.room.localParticipant?.registerRpcMethod(
      'set_system_prompt',
      async (data: RpcInvocationData) => {
        const prompt = parseValue(data.payload, '');
        if (!prompt || agent.instructions === prompt) {
          return '';
        }

        logger.info({ length: prompt.length }, 'system prompt updated');
        updateAgentInstructions(agent, prompt);
        return '';
      },
    );
  },
});

cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url) }));
