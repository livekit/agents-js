// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { type JobContext, WorkerOptions, cli, defineAgent, llm } from '@livekit/agents';
import { turnDetector } from '@livekit/agents-plugin-livekit';
import { fileURLToPath } from 'node:url';

export default defineAgent({
  entry: async (ctx: JobContext) => {
    await ctx.connect();

    const eouModel = new turnDetector.EnglishModel();

    const chatCtx = llm.ChatContext.empty();

    chatCtx.addMessage({
      role: 'user',
      content: 'Hello, how are you? My name is Brian.',
    });

    chatCtx.addMessage({
      role: 'assistant',
      content: 'Hello, Brian. How can I help you today?',
    });

    chatCtx.addMessage({
      role: 'user',
      content: 'I am looking for a uh',
    });

    const result = await eouModel.predictEndOfTurn(chatCtx);

    console.log(result);
  },
});

cli.runApp(new WorkerOptions({ agent: fileURLToPath(import.meta.url) }));
