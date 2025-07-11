// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { type JobContext, WorkerOptions, cli, defineAgent, llm, log } from '@livekit/agents';
import { turnDetector } from '@livekit/agents-plugin-livekit';
import { fileURLToPath } from 'node:url';

export default defineAgent({
  entry: async (ctx: JobContext) => {
    await ctx.connect();
    const logger = log();

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

    const chatCtxNonEndingTurn = chatCtx.copy();
    chatCtxNonEndingTurn.addMessage({
      role: 'user',
      content: 'What is weather in',
    });

    const chatCtxEndingTurn = chatCtx.copy();
    chatCtxEndingTurn.addMessage({
      role: 'user',
      content: 'What is weather in San Francisco?',
    });

    const resultNonEndingTurn = await eouModel.predictEndOfTurn(chatCtxNonEndingTurn);
    const resultEndingTurn = await eouModel.predictEndOfTurn(chatCtxEndingTurn);

    logger.info({ resultNonEndingTurn }, 'Non-ending turn result:');
    logger.info({ resultEndingTurn }, 'Ending turn result:');
  },
});

cli.runApp(new WorkerOptions({ agent: fileURLToPath(import.meta.url) }));
