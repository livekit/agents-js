// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { version } from './index';
import { Option, Command } from 'commander';

const program = new Command();
program
  .name('agents')
  .description('LiveKit Agents CLI')
  .version(version)
  .addOption(
    new Option('--log-level', 'Set the logging level').choices([
      'DEBUG',
      'INFO',
      'WARNING',
      'ERROR',
      'CRITICAL',
    ]),
  );

program
  .command('start')
  .description('Start the worker')
  .addOption(
    new Option('--url <string>', 'LiveKit server or Cloud project websocket URL')
      .makeOptionMandatory(true)
      .env('LIVEKIT_URL'),
  )
  .addOption(
    new Option('--api-key <string>', "LiveKit server or Cloud project's API key")
      .makeOptionMandatory(true)
      .env('LIVEKIT_API_KEY'),
  )
  .addOption(
    new Option('--api-secret <string>', "LiveKit server or Cloud project's API secret")
      .makeOptionMandatory(true)
      .env('LIVEKIT_API_SECRET'),
  )
  .action(() => {
    return;
  });

program.parse();
