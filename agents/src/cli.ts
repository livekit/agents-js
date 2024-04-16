// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { version } from '.';
import { Option, Command } from 'commander';
import { WorkerOptions, Worker } from './worker';
import { EventEmitter } from 'events';
import { log } from './log';

type CliArgs = {
  opts: WorkerOptions;
  logLevel: string;
  production: boolean;
  watch: boolean;
  event?: EventEmitter;
};

const runWorker = async (args: CliArgs) => {
  log.level = args.logLevel;
  const worker = new Worker(args.opts);

  process.on('SIGINT', async () => {
    await worker.close();
    log.info('worker closed');
    process.exit(130); // SIGINT exit code
  });

  try {
    await worker.run();
  } catch {
    log.fatal('worker failed');
    process.exit(1);
  }
};

export const runApp = (opts: WorkerOptions) => {
  const program = new Command()
    .name('agents')
    .description('LiveKit Agents CLI')
    .version(version)
    .addOption(
      new Option('--log-level <level>', 'Set the logging level')
        .choices(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])
        .default('trace'),
    )
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
    );

  program
    .command('start')
    .description('Start the worker in production mode')
    .action(() => {
      const options = program.optsWithGlobals();
      opts.wsURL = options.url || opts.wsURL;
      opts.apiKey = options.apiKey || opts.apiKey;
      opts.apiSecret = options.apiSecret || opts.apiSecret;
      runWorker({
        opts,
        production: true,
        watch: false,
        logLevel: options.logLevel,
      });
    });

  program.parse();
};
