// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { type JobContext, WorkerOptions, cli, defineAgent, llm, log, voice } from '@livekit/agents';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/**
 * Example demonstrates how to play background audio / sound effects in an agent session.
 * It uses the BackgroundAudioPlayer class to manage audio playback to the room.
 * Background audio could make the agent feel more realistic, versus perfect silence
 * in the background.
 *
 * This example plays:
 * - Ambient office sounds continuously in the background
 * - Keyboard typing sounds when the agent is thinking (e.g., during tool calls)
 */

export default defineAgent({
  entry: async (ctx: JobContext) => {
    const logger = log();

    await ctx.connect();
    logger.info('Connected to room');

    const searchWeb = llm.tool({
      description:
        'Search the web for information based on the given query. Always use this function whenever the user requests a web search',
      parameters: z.object({
        query: z.string().describe('The search query to look up on the web.'),
      }),
      execute: async ({ query }) => {
        logger.info('FakeWebSearchAgent thinking...');
        await new Promise((resolve) => setTimeout(resolve, 5000));
        return `The request failed on ${query}, give the users some information based on your knowledge`;
      },
    });

    const agent = new voice.Agent({
      instructions: 'You are a helpful assistant',
      tools: {
        searchWeb,
      },
    });

    const session = new voice.AgentSession({
      llm: 'deepseek-ai/deepseek-v3',
      stt: 'deepgram/nova-3',
      tts: 'cartesia',
    });
    await session.start({ agent, room: ctx.room });

    const backgroundAudio = new voice.BackgroundAudioPlayer({
      ambientSound: voice.BuiltinAudioClip.OFFICE_AMBIENCE,
      thinkingSound: [
        { source: voice.BuiltinAudioClip.KEYBOARD_TYPING, volume: 0.8, probability: 0.6 },
        { source: voice.BuiltinAudioClip.KEYBOARD_TYPING2, volume: 0.7, probability: 0.4 },
      ],
    });

    await backgroundAudio.start({ room: ctx.room, agentSession: session });

    // Play another audio file at any time using the play method:
    // backgroundAudio.play('filepath.ogg');
  },
});

cli.runApp(new WorkerOptions({ agent: fileURLToPath(import.meta.url) }));
