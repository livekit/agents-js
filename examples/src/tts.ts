// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { type JobContext, WorkerOptions, cli, defineAgent } from '@livekit/agents';
import { SynthesizeStream, TTS } from '@livekit/agents-plugin-elevenlabs';
import {
  AudioSource,
  LocalAudioTrack,
  RoomEvent,
  TrackPublishOptions,
  TrackSource,
} from '@livekit/rtc-node';
import { fileURLToPath } from 'node:url';

export default defineAgent({
  entry: async (ctx: JobContext) => {
    await ctx.connect();

    console.log('starting TTS example agent');

    const source = new AudioSource(22050, 1);
    const track = LocalAudioTrack.createAudioTrack('agent-mic', source);
    const options = new TrackPublishOptions();
    options.source = TrackSource.SOURCE_MICROPHONE;

    await ctx.room.localParticipant?.publishTrack(track, options);
    const stream = new TTS().stream();

    ctx.room.on(RoomEvent.LocalTrackSubscribed, async () => {
      console.log('speaking "Hello!"');
      stream.pushText('Hello!');
      stream.flush();

      await new Promise<void>((resolve) => setTimeout(resolve, 2000));

      console.log('speaking "Goodbye!"');
      stream.pushText('Goodbye!');
      stream.flush();
      stream.endInput();
    });

    for await (const audio of stream) {
      if (audio !== SynthesizeStream.END_OF_STREAM) {
        await source.captureFrame(audio.frame);
      }
    }
  },
});

cli.runApp(new WorkerOptions({ agent: fileURLToPath(import.meta.url) }));
