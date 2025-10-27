// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { type JobContext, WorkerOptions, cli, defineAgent, log, voice } from '@livekit/agents';
import { fileURLToPath } from 'node:url';

/**
 * Example demonstrating BackgroundAudioPlayer usage
 *
 * This example shows how to play continuous background audio (ambient sound)
 * while an agent is in a LiveKit room.
 *
 * NOTE: Thinking sound is not yet supported (requires AudioMixer implementation)
 */

export default defineAgent({
  entry: async (ctx: JobContext) => {
    const logger = log();

    await ctx.connect();
    logger.info('Connected to room');

    // Create background audio player with ambient office sound
    const backgroundAudio = new voice.BackgroundAudioPlayer({
      ambientSound: {
        source: voice.BuiltinAudioClip.OFFICE_AMBIENCE,
        volume: 0.6, // 60% volume
      },
      // TODO: thinkingSound requires AudioMixer - not yet supported
      // thinkingSound: [
      //   { source: voice.BuiltinAudioClip.KEYBOARD_TYPING, volume: 0.8, probability: 0.5 },
      //   { source: voice.BuiltinAudioClip.KEYBOARD_TYPING2, volume: 0.7, probability: 0.5 },
      // ],
    });

    // Start background audio
    await backgroundAudio.start({ room: ctx.room });
    logger.info(`Background audio started, track: ${backgroundAudio.publication?.sid}`);

    // The ambient sound will now loop continuously in the background
    // Other participants in the room will hear it

    // You can play additional sounds at any time:
    // const handle = backgroundAudio.play(voice.BuiltinAudioClip.KEYBOARD_TYPING);
    // await handle.waitForPlayout(); // Wait for it to finish
    // or handle.stop(); // Stop it early

    // Keep the agent running
    await new Promise(() => {
      /* never resolves */
    });
  },
});

cli.runApp(new WorkerOptions({ agent: fileURLToPath(import.meta.url) }));
