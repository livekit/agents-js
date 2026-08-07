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
  log,
} from '@livekit/agents';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseSessionConfig } from './expressive_agent/protocol.ts';

const instructions = readFileSync(
  new URL('../src/expressive_agent/prompt.md', import.meta.url),
  'utf8',
).replace(/^<!--[\s\S]*?-->\s*/, '');

const greeting =
  "Open the call the way you'd answer the phone to someone you know well. " +
  "Short and warm, and leave them room to say what's going on.";

class Friend extends Agent {
  constructor() {
    super({ instructions });
  }

  async onEnter(): Promise<void> {
    this.session.generateReply({ instructions: greeting });
  }
}

export default defineAgent({
  entry: async (ctx: JobContext) => {
    const config = parseSessionConfig(ctx.job.metadata);
    log().info(
      { expressive: config.expressive, voice: config.voice.label },
      'starting expressive session',
    );

    const session = new AgentSession({
      stt: new inference.STT({ model: 'assemblyai/universal-3-5-pro', language: 'en' }),
      llm: new inference.LLM({ model: 'google/gemma-4-31b-it' }),
      tts: new inference.TTS({ model: config.voice.model, voice: config.voice.voice }),
      turnHandling: {
        turnDetection: new inference.TurnDetector({ version: 'v1' }),
        interruption: { mode: 'adaptive' },
        preemptiveGeneration: { enabled: true },
      },
      expressive: config.expressive,
    });

    await session.start({ agent: new Friend(), room: ctx.room });
    await ctx.room.localParticipant?.setAttributes(config.attributes());
  },
});

cli.runApp(
  new ServerOptions({
    agent: fileURLToPath(import.meta.url),
    agentName: 'expressive-agent-js',
  }),
);
