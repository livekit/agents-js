// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { type JobContext, type JobRequest, WorkerOptions, cli, defineAgent } from '@livekit/agents';
import { fileURLToPath } from 'url';

const requestFunc = async (req: JobRequest) => {
  console.log('received request', req);
  await req.accept(__filename);
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  cli.runApp(new WorkerOptions({ requestFunc }));
}

// your entry file has to provide a default export of type Agent.
// use the defineAgent() helper function to generate your agent.
export default defineAgent(async (job: JobContext) => {
  console.log('starting voice assistant...');
  job;
  // etc
});
