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
import * as krisp from '@livekit/agents-plugin-krisp';
import { fileURLToPath } from 'node:url';
import { publishFrontendAttributes } from './behaviors/frontend_attributes.js';
import { checkInWhenUserAway } from './behaviors/user_away.js';
import { pronounceLiveKit } from './filters/pronunciation.js';
import { KnowledgeBase } from './knowledge_base/index.js';
import { prompt } from './prompts/index.js';

export class AgentConfig {
  readonly name: string;
  readonly llmModel: string;
  readonly sttModel: string;
  readonly sttLanguage: string;
  readonly ttsModel: string;
  readonly ttsVoice: string;
  readonly ttsVoiceLabel: string;

  constructor({
    name = 'homepage_agent_v3',
    llmModel = 'google/gemma-4-31b-it',
    sttModel = 'deepgram/nova-3',
    sttLanguage = 'multi',
    ttsModel = 'fishaudio/s2.1-pro',
    ttsVoice = '51b44863613e405a896f7f4294c6e6d0',
    ttsVoiceLabel = 'Marley',
  }: Partial<AgentConfig> = {}) {
    this.name = name;
    this.llmModel = llmModel;
    this.sttModel = sttModel;
    this.sttLanguage = sttLanguage;
    this.ttsModel = ttsModel;
    this.ttsVoice = ttsVoice;
    this.ttsVoiceLabel = ttsVoiceLabel;
    Object.freeze(this);
  }
}

export const CONFIG = new AgentConfig();
export const KNOWLEDGE_BASE = new KnowledgeBase();
export const INSTRUCTIONS = prompt('agents_sdks');
export const GREETING = prompt('greeting');

export class Assistant extends Agent {
  constructor(config: AgentConfig = CONFIG, knowledgeBase: KnowledgeBase = KNOWLEDGE_BASE) {
    super({
      llm: new inference.LLM({ model: config.llmModel }),
      instructions: INSTRUCTIONS,
      tools: [knowledgeBase.lookupTool()],
    });
  }

  override async onEnter(): Promise<void> {
    await this.session.generateReply({ instructions: GREETING, allowInterruptions: true });
  }
}

export default defineAgent({
  entry: async (ctx: JobContext) => {
    const session = new AgentSession({
      stt: new inference.STT({ model: CONFIG.sttModel, language: CONFIG.sttLanguage }),
      tts: new inference.TTS({ model: CONFIG.ttsModel, voice: CONFIG.ttsVoice }),
      turnHandling: {
        turnDetection: new inference.TurnDetector(),
        preemptiveGeneration: { enabled: true },
      },
      expressive: true,
      ttsTextTransforms: ['filter_markdown', 'filter_emoji', pronounceLiveKit],
    });

    checkInWhenUserAway(session);

    await session.start({
      agent: new Assistant(),
      room: ctx.room,
      inputOptions: { noiseCancellation: krisp.voiceIsolation() },
    });
    await publishFrontendAttributes({ ttsVoice: CONFIG.ttsVoiceLabel });
  },
});

const agentFile = fileURLToPath(import.meta.url);
if (process.argv[1] === agentFile) {
  cli.runApp(new ServerOptions({ agent: agentFile, agentName: CONFIG.name }));
}
