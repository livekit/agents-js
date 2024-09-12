// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { type JobContext, WorkerOptions, cli, defineAgent, log } from '@livekit/agents';
import { TTS } from '@livekit/agents-plugin-elevenlabs';
import { AudioSource, LocalAudioTrack, TrackPublishOptions, TrackSource } from '@livekit/rtc-node';
import { fileURLToPath } from 'url';

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  cli.runApp(new WorkerOptions({ agent: import.meta.filename }));
}

export default defineAgent({
  entry: async (ctx: JobContext) => {
    await ctx.connect();
    log().info('starting TTS example agent');

    const source = new AudioSource(24000, 1);
    const track = LocalAudioTrack.createAudioTrack('agent-mic', source);
    const options = new TrackPublishOptions();
    options.source = TrackSource.SOURCE_MICROPHONE;
    await ctx.room.localParticipant?.publishTrack(track, options);

    const tts = new TTS();
    log().info('speaking "Hello!"');
    await tts
      .synthesize('Hello!')
      .then((output) => output.collect())
      .then((output) => {
        source.captureFrame(output);
      });

    await new Promise((resolve) => setTimeout(resolve, 1000));

    log().info('speaking "Goodbye."');
    await tts
      .synthesize('Goodbye.')
      .then((output) => output.collect())
      .then((output) => {
        source.captureFrame(output);
      });
  },
});
