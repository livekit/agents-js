// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { type JobContext, WorkerOptions, cli, defineAgent } from '@livekit/agents';
import { VoiceAssistant, defaultInferenceConfig } from '@livekit/agents-plugin-openai';

export default defineAgent({
  entry: async (ctx: JobContext) => {
    await ctx.connect();

    console.log('starting assistant example agent');

    const assistant = new VoiceAssistant({
      ...defaultInferenceConfig,
      system_message: 'You are a helpful assistant.',
    });

    await assistant.start(ctx.room);

    assistant.addUserMessage('Hello! Can you share a very short?');
  },
});

// check that we're running this file and not importing functions from it
// without this if closure, our code would start` a new Agents process on every job process.
if (process.argv[1] === import.meta.filename) {
  cli.runApp(new WorkerOptions({ agent: import.meta.filename }));
}
