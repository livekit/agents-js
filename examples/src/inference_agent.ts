// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
// LiveKit Playground agent on the inference gateway: the user prototypes their
// own voice agent, swapping the STT / LLM / TTS models and the system prompt
// live via RPC. Port of livekit/agents examples/inference/agent.py.
import {
  type JobContext,
  ServerOptions,
  cli,
  defineAgent,
  inference,
  log,
  voice,
} from '@livekit/agents';
import type { RpcInvocationData } from '@livekit/rtc-node';
import { fileURLToPath } from 'node:url';

const DEFAULT_STT = 'deepgram/nova-3';
const DEFAULT_LLM = 'google/gemma-4-31b-it';
const DEFAULT_TTS = 'inworld/inworld-tts-2';

// Default starter prompt. Keep in sync with the `set_system_prompt`
// control's `default` in the playground config — the UI seeds the
// textarea with the same string so the first session before any edit
// matches what the user sees.
const INSTRUCTIONS =
  "You're a friendly agent in the LiveKit Playground. The person " +
  'talking to you is prototyping their own voice agent — they can ' +
  'edit this prompt in the side panel and swap the STT / LLM / TTS ' +
  'models live. Keep replies short, natural, and conversational, and ' +
  'be expressive so they can hear what the selected voice can do. ' +
  'At the start of the conversation, set the tone and pace — open with ' +
  'warm, upbeat energy and a quick, inviting question to encourage the ' +
  'user to engage and let them know they can talk to you naturally. ' +
  "If the conversation lulls or they're not sure what to try, offer " +
  'to tell them a short joke — and if they say yes, deliver it with ' +
  "good comic timing. If asked which models you're using, answer honestly.";

const swapPrompt = (modality: string, model: string) =>
  `The user just switched the ${modality} model to '${model}'. ` +
  "Acknowledge it in one short, natural sentence — say the model's " +
  "name like a brand (e.g. 'Deepgram Nova 3', not 'deepgram slash " +
  "nova dash three'). Skip hyphens, slashes, version dots, and any " +
  "abbreviations that aren't pronounceable. Don't ask a follow-up.";

class InferenceAgent extends voice.Agent {
  constructor(instructions: string = INSTRUCTIONS) {
    super({ instructions });
  }

  async onEnter(): Promise<void> {
    // Fired once the agent is active and RoomIO has subscribed to the
    // participant's tracks, so the greeting is delivered to a connected
    // client rather than spoken before the audio socket is up. Runs on
    // the session's default LLM (Gemma) — no model-routing needed here.
    this.session.generateReply({
      instructions:
        'Greet the user with excitement, and ask them how their day is going. ' +
        'Keep it to one or two short, natural sentences.',
    });
  }
}

export default defineAgent({
  entry: async (ctx: JobContext) => {
    const logger = log();

    const session = new voice.AgentSession({
      stt: new inference.STT({ model: DEFAULT_STT }),
      llm: new inference.LLM({ model: DEFAULT_LLM }),
      tts: new inference.TTS({
        model: DEFAULT_TTS,
        voice: 'Sarah',
        modelOptions: { delivery_mode: 'CREATIVE' },
      }),
      expressive: voice.presets.CASUAL,
      // Flip userState to "away" after 10s of mutual silence so we can
      // check whether they're still there (default is 15s).
      userAwayTimeout: 10.0,
    });

    let idleNudge: AbortController | null = null;

    const nudgeWhileIdle = async (signal: AbortSignal) => {
      // Nudge every 10s until the user speaks again — speaking flips
      // userState out of "away", which aborts this loop below.
      while (!signal.aborted) {
        logger.info("user idle — checking if they're still there");
        await session.generateReply({
          instructions: "The user has been idle, see if they're still there",
        });
        await new Promise((resolve) => setTimeout(resolve, 10_000));
      }
    };

    session.on(voice.AgentSessionEventTypes.UserStateChanged, (ev) => {
      if (ev.newState === 'away') {
        if (idleNudge === null) {
          idleNudge = new AbortController();
          void nudgeWhileIdle(idleNudge.signal);
        }
      } else if (idleNudge !== null) {
        idleNudge.abort();
        idleNudge = null;
      }
    });

    const parseValue = (payload: string, fallback: string): string => {
      try {
        const v = (JSON.parse(payload) as Record<string, unknown>).value;
        return typeof v === 'string' && v ? v : fallback;
      } catch {
        return fallback;
      }
    };

    const agent = new InferenceAgent();
    await session.start({ agent, room: ctx.room });

    ctx.room.localParticipant?.registerRpcMethod(
      'set_stt_model',
      async (data: RpcInvocationData) => {
        const model = parseValue(data.payload, DEFAULT_STT);
        const stt = session.stt;
        if (!(stt instanceof inference.STT) || stt.model === model) {
          return '';
        }
        logger.info(`switching STT → ${model}`);
        stt.updateOptions({ model });
        session.generateReply({ instructions: swapPrompt('speech-to-text', model) });
        return '';
      },
    );

    ctx.room.localParticipant?.registerRpcMethod(
      'set_llm_model',
      async (data: RpcInvocationData) => {
        const model = parseValue(data.payload, DEFAULT_LLM);
        const llm = session.llm;
        if (!(llm instanceof inference.LLM) || llm.model === model) {
          return '';
        }
        logger.info(`switching LLM → ${model}`);
        llm.updateOptions({ model });
        session.generateReply({ instructions: swapPrompt('language', model) });
        return '';
      },
    );

    ctx.room.localParticipant?.registerRpcMethod(
      'set_tts_model',
      async (data: RpcInvocationData) => {
        const model = parseValue(data.payload, DEFAULT_TTS);
        const tts = session.tts;
        if (!(tts instanceof inference.TTS) || tts.model === model) {
          return '';
        }
        logger.info(`switching TTS → ${model}`);
        tts.updateOptions({ model });
        session.generateReply({ instructions: swapPrompt('text-to-speech', model) });
        return '';
      },
    );

    ctx.room.localParticipant?.registerRpcMethod('open_in_builder', async () => {
      // Build the Cloud Builder deep-link agent-side so the
      // frontend doesn't have to know the URL schema. `p_` is a
      // placeholder project_id — Cloud routes the user through
      // login if needed and preserves the params on redirect.
      const params = new URLSearchParams({
        modelMode: 'pipeline',
        instructions: agent.instructions.toString() || '',
        llm: session.llm instanceof inference.LLM ? session.llm.model : DEFAULT_LLM,
        stt: session.stt instanceof inference.STT ? session.stt.model : DEFAULT_STT,
        tts: session.tts instanceof inference.TTS ? session.tts.model : DEFAULT_TTS,
      });
      return `https://cloud.livekit.io/projects/p_/agents/builder/new?${params.toString()}`;
    });

    ctx.room.localParticipant?.registerRpcMethod(
      'set_system_prompt',
      async (data: RpcInvocationData) => {
        // The UI fires this on every keystroke (debounced client-side
        // by the textarea's edit→commit boundary), so dedupe against
        // the current value before touching the agent. updateInstructions
        // is cheap but it logs.
        const prompt = parseValue(data.payload, '');
        if (!prompt) {
          return '';
        }
        if (agent.instructions === prompt) {
          return '';
        }
        logger.info(`system prompt updated (${prompt.length} chars)`);
        await agent.updateInstructions(prompt);
        return '';
      },
    );
  },
});

// Only run CLI when executed directly, not when imported for testing.
// eslint-disable-next-line turbo/no-undeclared-env-vars
if (process.env.VITEST === undefined) {
  cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url) }));
}
