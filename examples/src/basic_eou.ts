// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { type JobContext, WorkerOptions, cli, defineAgent, llm, log } from '@livekit/agents';
import { turnDetector } from '@livekit/agents-plugin-livekit';
import { fileURLToPath } from 'node:url';

async function runEou(model: turnDetector.EOUModel, modelName: string) {
  const logger = log();

  logger.info('='.repeat(60));
  logger.info(`Testing ${modelName} End-of-Utterance Model`);
  logger.info('='.repeat(60));

  // Create base conversation context
  const chatCtx = llm.ChatContext.empty();

  chatCtx.addMessage({
    role: 'user',
    content: 'Hello, how are you? My name is Brian.',
  });

  chatCtx.addMessage({
    role: 'assistant',
    content: 'Hello, Brian. How can I help you today?',
  });

  logger.debug(
    {
      messages: chatCtx.items.map((item) => ({
        role: item.type === 'message' ? item.role : item.type,
        content: item.type === 'message' ? item.content : 'N/A',
      })),
    },
    'Base conversation context:',
  );

  // Test 1: Incomplete utterance
  logger.info('\n📝 Test 1: Incomplete utterance (should have LOW probability)');
  const chatCtxNonEndingTurn = chatCtx.copy();
  chatCtxNonEndingTurn.addMessage({
    role: 'user',
    content: 'What is weather in',
  });

  logger.debug({ content: 'What is weather in' }, 'Testing message:');

  const startTime1 = Date.now();
  const resultNonEndingTurn = await model.predictEndOfTurn(chatCtxNonEndingTurn);
  const duration1 = Date.now() - startTime1;

  const threshold = await model.unlikelyThreshold();

  logger.info(
    {
      probability: resultNonEndingTurn.toFixed(3),
      threshold: threshold?.toFixed(3) || 'N/A',
      isEndOfTurn: threshold ? resultNonEndingTurn > threshold : 'N/A',
      duration: `${duration1}ms`,
      verdict:
        resultNonEndingTurn < 0.15
          ? '✅ PASS (Low probability as expected)'
          : '❌ FAIL (High probability unexpected)',
    },
    'Result:',
  );

  // Test 2: Complete utterance
  logger.info('\n📝 Test 2: Complete utterance (should have HIGH probability)');
  const chatCtxEndingTurn = chatCtx.copy();
  chatCtxEndingTurn.addMessage({
    role: 'user',
    content: 'What is weather in San Francisco?',
  });

  logger.debug({ content: 'What is weather in San Francisco?' }, 'Testing message:');

  const startTime2 = Date.now();
  const resultEndingTurn = await model.predictEndOfTurn(chatCtxEndingTurn);
  const duration2 = Date.now() - startTime2;

  logger.info(
    {
      probability: resultEndingTurn.toFixed(3),
      threshold: threshold?.toFixed(3) || 'N/A',
      isEndOfTurn: threshold ? resultEndingTurn > threshold : 'N/A',
      duration: `${duration2}ms`,
      verdict:
        resultEndingTurn > 0.15
          ? '✅ PASS (High probability as expected)'
          : '❌ FAIL (Low probability unexpected)',
    },
    'Result',
  );

  // Summary
  logger.info(
    {
      model: modelName,
      incompleteUtteranceProbability: resultNonEndingTurn.toFixed(3),
      completeUtteranceProbability: resultEndingTurn.toFixed(3),
      difference: (resultEndingTurn - resultNonEndingTurn).toFixed(3),
      avgDuration: `${((duration1 + duration2) / 2).toFixed(0)}ms`,
    },
    '📊 Summary',
  );
}

export default defineAgent({
  entry: async (ctx: JobContext) => {
    const logger = log();

    try {
      logger.info('🚀 Starting End-of-Utterance detection tests');
      logger.info(`Connecting to LiveKit...`);

      await ctx.connect();
      logger.info('✅ Connected to LiveKit');

      logger.info('🔧 Initializing models...');
      const enModel = new turnDetector.EnglishModel();
      const intlModel = new turnDetector.MultilingualModel();
      logger.info('✅ Models initialized');

      // Run tests
      await runEou(enModel, 'English');
      await runEou(intlModel, 'Multilingual');

      logger.info('✅ All tests completed successfully!');
    } catch (error) {
      logger.error({ error }, '❌ Error during EOU testing');
      throw error;
    }
  },
});

cli.runApp(new WorkerOptions({ agent: fileURLToPath(import.meta.url) }));
