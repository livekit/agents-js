// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { type JobContext, WorkerOptions, cli, defineAgent, llm, log } from '@livekit/agents';
import { turnDetector } from '@livekit/agents-plugin-livekit';
import { fileURLToPath } from 'node:url';

export default defineAgent({
  entry: async (ctx: JobContext) => {
    const logger = log();

    // Manual connection required since this example doesn't use AgentSession
    await ctx.connect();

    // const eouModel = new turnDetector.EnglishModel();
    const eouModel = new turnDetector.MultilingualModel();

    const unlikelyThreshold = await eouModel.unlikelyThreshold('en');
    logger.info({ unlikelyThreshold }, 'unlikelyThreshold');

    const chatCtx = llm.ChatContext.empty();
    chatCtx.addMessage({
      role: 'assistant',
      content: 'Hi, how can I help you today?',
    });

    const nonEndingTurn = chatCtx.copy();
    nonEndingTurn.addMessage({
      role: 'user',
      content: 'What is the weather in',
    });

    const nonEndingTurnResult = await eouModel.predictEndOfTurn(nonEndingTurn);
    logger.info({ nonEndingTurnResult }, 'nonEndingTurnResult');

    const endingTurn = chatCtx.copy();
    endingTurn.addMessage({
      role: 'user',
      content: 'What is the weather in San Francisco?',
    });

    const endingTurnResult = await eouModel.predictEndOfTurn(endingTurn);
    logger.info({ endingTurnResult }, 'endingTurnResult');
  },
});

cli.runApp(new WorkerOptions({ agent: fileURLToPath(import.meta.url) }));
