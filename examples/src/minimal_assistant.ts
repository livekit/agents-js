// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { type JobContext, WorkerOptions, cli, defineAgent } from '@livekit/agents';
import { VoiceAssistant, defaultInferenceConfig } from '@livekit/agents-plugin-openai';

export default defineAgent({
  entry: async (ctx: JobContext) => {
    await ctx.connect();

    console.log('starting assistant example agent');

    // FIXME: https://linear.app/livekit/issue/AGT-386/voice-assistant-doesnt-wait-correctly-before-listeningpublishing
    setTimeout(() => {
      const assistant = new VoiceAssistant({
        ...defaultInferenceConfig,
        system_message: 'You talk unprompted.',
      });
      assistant.start(ctx.room);
    }, 1000);
  },
});

// check that we're running this file and not importing functions from it
// without this if closure, our code would start` a new Agents process on every job process.
if (process.argv[1] === import.meta.filename) {
  cli.runApp(new WorkerOptions({ agent: import.meta.filename }));
}
