#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Command } from 'commander';
import { main as downloadFilesMain } from '../download.js';
import { version } from '../version.js';

const program = new Command()
  .name('livekit-agents')
  .description('LiveKit Agents standalone CLI')
  .version(version);

program
  .command('download-files')
  .description(
    'Discover installed @livekit/agents-plugin-* packages and run their downloadFiles() ' +
      'without loading your agent code. Intended for Dockerfile layer caching.',
  )
  .action(async () => {
    const code = await downloadFilesMain();
    process.exit(code);
  });

program.parseAsync(process.argv).catch((error) => {
  console.error(`Fatal error: ${error}`);
  process.exit(1);
});
