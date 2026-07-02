// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
// Minimal agent for E2E testing of cgroup-aware CPU load reporting.
// Uses the default loadFunc (no override) so the cgroup monitor is exercised.
import { WorkerOptions, cli, defineAgent } from '@livekit/agents';
import { fileURLToPath } from 'node:url';

export default defineAgent({
  entry: async (ctx) => {
    console.log('[e2e-test-agent] job received, connecting to room');
    await ctx.connect();
    console.log('[e2e-test-agent] connected to room:', ctx.room.name);
  },
});

cli.runApp(
  new WorkerOptions({
    agent: fileURLToPath(import.meta.url),
  }),
);
