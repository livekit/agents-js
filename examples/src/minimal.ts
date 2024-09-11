// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { type JobContext, WorkerOptions, cli, defineAgent } from '@livekit/agents';
import { TTS } from '@livekit/agents-plugin-elevenlabs';
import { AudioSource, LocalAudioTrack, TrackPublishOptions, TrackSource } from '@livekit/rtc-node';

export default defineAgent({
  entry: async (ctx: JobContext) => {
    await ctx.connect();
    console.log('starting TTS example agent');

    // prepare our audio track and start publishing it to the room
    const source = new AudioSource(24000, 1);
    const track = LocalAudioTrack.createAudioTrack('agent-mic', source);
    const options = new TrackPublishOptions();
    options.source = TrackSource.SOURCE_MICROPHONE;
    await ctx.room.localParticipant?.publishTrack(track, options);

    // ask ElevenLabs to synthesize "Hello!"
    const tts = new TTS();
    console.log('speaking "Hello!"');
    await tts
      .synthesize('Hello!')
      .then((output) => output.collect())
      .then((output) => {
        // send the audio to our track
        source.captureFrame(output);
      });
  },
});

// check that we're running this file and not importing functions from it
// without this if closure, our code would start` a new Agents process on every job process.
if (process.argv[1] === import.meta.filename) {
  cli.runApp(new WorkerOptions({ agent: import.meta.filename }));
}
