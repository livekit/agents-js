// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { type JobContext, type JobRequest, WorkerOptions, cli, defineAgent } from '@livekit/agents';
import { VoiceAssistant } from '@livekit/agents-plugin-openai';

export default defineAgent({
  entry: async (job: JobContext) => {
    console.log('starting assistant example agent');

    const assistant = new VoiceAssistant();
    assistant.start(job.room);
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
