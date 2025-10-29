// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type JobContext,
  WorkerOptions,
  cli,
  defineAgent,
  log,
  loopAudioFramesFromFile,
} from '@livekit/agents';
import { AudioSource, LocalAudioTrack, TrackPublishOptions, TrackSource } from '@livekit/rtc-node';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export default defineAgent({
  entry: async (ctx: JobContext) => {
    const logger = log();

    await ctx.connect();

    logger.info('Playing audio file to LiveKit track...');

    const audioSource = new AudioSource(48000, 1);

    const track = LocalAudioTrack.createAudioTrack('background_audio', audioSource);

    const publication = await ctx.room.localParticipant!.publishTrack(
      track,
      new TrackPublishOptions({
        source: TrackSource.SOURCE_MICROPHONE,
      }),
    );

    await publication.waitForSubscription();

    logger.info(`Audio track published: ${publication?.sid}`);

    const currentDir = dirname(fileURLToPath(import.meta.url));
    const resourcesPath = join(currentDir, '../../agents/resources');
    const audioFile = join(resourcesPath, 'office-ambience.ogg');

    logger.info(`Playing: ${audioFile}`);

    const abortController = new AbortController();

    ctx.addShutdownCallback(async () => {
      abortController.abort();
    });

    let frameCount = 0;
    for await (const frame of loopAudioFramesFromFile(audioFile, {
      sampleRate: 48000,
      numChannels: 1,
      abortSignal: abortController.signal,
    })) {
      await audioSource.captureFrame(frame);
      frameCount++;

      if (frameCount % 100 === 0) {
        logger.info(`Played ${frameCount} frames (${(frameCount * 0.1).toFixed(1)}s)`);
      }
    }
  },
});

cli.runApp(new WorkerOptions({ agent: fileURLToPath(import.meta.url) }));
