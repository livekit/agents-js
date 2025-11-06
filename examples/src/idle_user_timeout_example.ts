// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Minimal example demonstrating idle user timeout functionality.
 * Direct port of: https://github.com/livekit/agents/blob/main/examples/voice_agents/inactive_user.py
 */
import {
  type JobContext,
  type JobProcess,
  Task,
  WorkerOptions,
  cli,
  defineAgent,
  log,
  voice,
} from '@livekit/agents';
import * as openai from '@livekit/agents-plugin-openai';
import * as silero from '@livekit/agents-plugin-silero';
import { fileURLToPath } from 'node:url';

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load();
  },
  entry: async (ctx: JobContext) => {
    const logger = log();
    const vad = ctx.proc.userData.vad! as silero.VAD;

    const session = new voice.AgentSession({
      vad,
      llm: new openai.LLM({ model: 'gpt-4o-mini' }),
      stt: 'assemblyai/universal-streaming:en',
      tts: 'cartesia/sonic-2:9626c31c-bec5-4cca-baa8-f8ba9e84c8bc',

      voiceOptions: {
        userAwayTimeout: 12.5,
      },
    });

    let task: Task<void> | null = null;

    const userPresenceTask = async (controller: AbortController): Promise<void> => {
      for (let i = 0; i < 3; i++) {
        if (controller.signal.aborted) return;

        const reply = await session.generateReply({
          instructions: 'The user has been inactive. Politely check if the user is still present.',
        });

        await reply.waitForPlayout();

        await new Promise<void>((resolve) => {
          const timeout = setTimeout(resolve, 10000);
          controller.signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timeout);
              resolve();
            },
            { once: true },
          );
        });
      }

      if (!controller.signal.aborted) {
        await session.close();
      }
    };

    session.on(voice.AgentSessionEventTypes.UserStateChanged, (event) => {
      logger.info({ event }, 'User state changed');

      if (task) {
        task.cancel();
      }

      if (event.newState === 'away') {
        task = Task.from(userPresenceTask);
        return;
      }
    });

    const agent = new voice.Agent({
      instructions: 'You are a helpful assistant.',
    });

    await session.start({ agent, room: ctx.room });
  },
});

cli.runApp(new WorkerOptions({ agent: fileURLToPath(import.meta.url) }));
