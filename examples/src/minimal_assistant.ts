// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { type JobContext, type JobRequest, WorkerOptions, cli, defineAgent } from '@livekit/agents';
import { VoiceAssistant } from '@livekit/agents-plugin-openai';
import { AudioSource, LocalAudioTrack, TrackPublishOptions, TrackSource } from '@livekit/rtc-node';

export default defineAgent({
  entry: async (job: JobContext) => {
    console.log('starting assistant example agent');

    // prepare our audio track and start publishing it to the room
    const source = new AudioSource(24000, 1);
    const track = LocalAudioTrack.createAudioTrack('agent-mic', source);
    const options = new TrackPublishOptions();
    options.source = TrackSource.SOURCE_MICROPHONE;
    await job.room.localParticipant?.publishTrack(track, options);

    const assistant = new VoiceAssistant();
    assistant.connect();

    // ask ElevenLabs to synthesize "Hello!"
    // const tts = new TTS();
    // console.log('speaking "Hello!"');
    // await tts
    //   .synthesize('Hello!')
    //   .then((output) => output.collect())
    //   .then((output) => {
    //     // send the audio to our track
    //     source.captureFrame(output);
    //   });
  },
});

// the requestFunc function allows us to do some things on the main thread after worker connection
const requestFunc = async (req: JobRequest) => {
  // this line needs to be exact.
  // we are passing this file's path to Agents, in order to import it later and run our entry function.
  await req.accept(import.meta.filename);
};

// check that we're running this file and not importing functions from it
// without this if closure, our code would start` a new Agents process on every job process.
if (process.argv[1] === import.meta.filename) {
  cli.runApp(new WorkerOptions({ requestFunc }));
}
