// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type JobContext,
  type ModelSettings,
  ServerOptions,
  cli,
  defineAgent,
  inference,
  voice,
} from '@livekit/agents';
import { BackgroundVoiceCancellation } from '@livekit/noise-cancellation-node';
import { fileURLToPath } from 'node:url';
import { publishFrontendAttributes } from './behaviors/frontend_attributes.js';
import { checkInWhenUserAway } from './behaviors/user_away.js';
import { pronounceLiveKit } from './filters/pronunciation.js';
import { KnowledgeBase } from './knowledge_base/index.js';
import { prompt } from './prompts/index.js';

export type AgentConfig = Readonly<{
  name: string;
  llmModel: string;
  sttModel: string;
  sttLanguage: string;
  ttsModel: string;
  ttsVoice: string;
}>;

export const CONFIG: AgentConfig = Object.freeze({
  name: 'homepage_agent_v3',
  llmModel: 'google/gemma-4-31b-it',
  sttModel: 'deepgram/nova-3',
  sttLanguage: 'multi',
  ttsModel: 'inworld/inworld-tts-2',
  ttsVoice: 'Nate',
});

export function createAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return Object.freeze({ ...CONFIG, ...overrides });
}

export const KNOWLEDGE_BASE = new KnowledgeBase();

export const INSTRUCTIONS = prompt('agents_sdks');
export const GREETING = prompt('greeting');

export class Assistant extends voice.Agent {
  constructor({
    config = CONFIG,
    knowledgeBase = KNOWLEDGE_BASE,
  }: { config?: AgentConfig; knowledgeBase?: KnowledgeBase } = {}) {
    super({
      llm: new inference.LLM({ model: config.llmModel }),
      instructions: INSTRUCTIONS,
      tools: [knowledgeBase.lookupTool()],
    });
  }

  override async ttsNode(
    text: ReadableStream<string> | AsyncIterable<string>,
    modelSettings: ModelSettings,
  ) {
    return voice.Agent.default.ttsNode(this, pronounceLiveKit(text), modelSettings);
  }

  override async onEnter(): Promise<void> {
    await this.session.generateReply({
      instructions: GREETING,
      allowInterruptions: true,
    });
  }
}

export default defineAgent({
  entry: async (ctx: JobContext) => {
    const session = new voice.AgentSession({
      stt: new inference.STT({ model: CONFIG.sttModel, language: CONFIG.sttLanguage }),
      tts: new inference.TTS({ model: CONFIG.ttsModel, voice: CONFIG.ttsVoice }),
      turnHandling: {
        turnDetection: new inference.TurnDetector(),
        preemptiveGeneration: { enabled: true },
      },
    });

    checkInWhenUserAway(session);

    await ctx.connect();
    publishFrontendAttributes({ ttsVoice: CONFIG.ttsVoice });

    await session.start({
      agent: new Assistant(),
      room: ctx.room,
      inputOptions: {
        noiseCancellation: BackgroundVoiceCancellation(),
      },
    });
  },
});

// Only run CLI when executed directly, not when imported for testing.
// eslint-disable-next-line turbo/no-undeclared-env-vars
if (process.env.VITEST === undefined) {
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url), agentName: CONFIG.name }));
}
