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
} from '@livekit/agents';
import * as nvidia from '@livekit/agents-plugin-nvidia';
import * as openai from '@livekit/agents-plugin-openai';
import { fileURLToPath } from 'node:url';

export default defineAgent({
  entry: async (ctx: JobContext) => {
    const session = new AgentSession({
      stt: new nvidia.STT(),
      llm: new openai.LLM({ model: 'gpt-4o-mini' }),
      tts: new nvidia.TTS(),
      turnHandling: {
        preemptiveGeneration: { enabled: true },
        interruption: { resumeFalseInterruption: true, falseInterruptionTimeout: 1000 },
      },
    });

    await session.start({
      agent: new Agent({ instructions: 'You are a helpful voice AI assistant.' }),
      room: ctx.room,
    });
  },
});

cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url) }));
