// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Command, Option } from 'commander';
import type { EventEmitter } from 'events';
import { log } from './log.js';
import { version } from './version.js';
import { Worker, type WorkerOptions } from './worker.js';

type CliArgs = {
  opts: WorkerOptions;
  production: boolean;
  watch: boolean;
  event?: EventEmitter;
};

const runWorker = async (args: CliArgs) => {
  log.level = args.opts.logLevel;
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
        .default('info')
        .env('LOG_LEVEL'),
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
      opts.logLevel = options.logLevel || opts.logLevel;
      runWorker({
        opts,
        production: true,
        watch: false,
      });
    });

  program.parse();
};

// like runApp but without calling `start' in the CLI.
// useful for wrapped applications
export const runHeadless = (opts: WorkerOptions) => {
  opts.wsURL = process.env.LIVEKIT_URL || opts.wsURL;
  opts.apiKey = process.env.LIVEKIT_API_KEY || opts.apiKey;
  opts.apiSecret = process.env.LIVEKIT_API_SECRET || opts.apiSecret;
  opts.logLevel = process.env.LOG_LEVEL || opts.logLevel;

  runWorker({
    opts,
    production: true,
    watch: false,
  });
};
