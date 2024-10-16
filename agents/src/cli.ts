// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Command, Option } from 'commander';
import type { EventEmitter } from 'node:events';
import { initializeLogger, log } from './log.js';
import { version } from './version.js';
import { Worker, WorkerOptions } from './worker.js';

type CliArgs = {
  opts: WorkerOptions;
  production: boolean;
  watch: boolean;
  event?: EventEmitter;
  room?: string;
  participantIdentity?: string;
};

const runWorker = async (args: CliArgs) => {
  initializeLogger({ pretty: !args.production, level: args.opts.logLevel });
  const logger = log();

  // though `production` is defined in WorkerOptions, it will always be overriddden by CLI.
  const { production: _, ...opts } = args.opts; // eslint-disable-line @typescript-eslint/no-unused-vars
  const worker = new Worker(new WorkerOptions({ production: args.production, ...opts }));

  if (args.room) {
    worker.event.once('worker_registered', () => {
      logger.info(`connecting to room ${args.room}`);
      worker.simulateJob(args.room!, args.participantIdentity);
    });
  }

  process.once('SIGINT', async () => {
    // allow C-c C-c for force interrupt
    process.once('SIGINT', () => {
      logger.info('worker closed forcefully');
      process.exit(130); // SIGINT exit code
    });
    if (args.production) {
      await worker.drain();
    }
    await worker.close();
    logger.info('worker closed');
    process.exit(130); // SIGINT exit code
  });

  try {
    await worker.run();
  } catch {
    logger.fatal('worker failed');
    process.exit(1);
  }
};

/**
 * Exposes a CLI for creating a new worker, in development or production mode.
 *
 * @param opts - Options to launch the worker with
 * @example
 * ```
 * if (process.argv[1] === fileURLToPath(import.meta.url)) {
 *   cli.runApp(new WorkerOptions({ agent: import.meta.filename }));
 * }
 * ```
 */
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
      new Option('--url <string>', 'LiveKit server or Cloud project websocket URL').env(
        'LIVEKIT_URL',
      ),
    )
    .addOption(
      new Option('--api-key <string>', "LiveKit server or Cloud project's API key").env(
        'LIVEKIT_API_KEY',
      ),
    )
    .addOption(
      new Option('--api-secret <string>', "LiveKit server or Cloud project's API secret").env(
        'LIVEKIT_API_SECRET',
      ),
    )
    .action(() => {
      if (
        // do not run CLI if origin file is agents/ipc/job_main.js
        process.argv[1] !== new URL('ipc/job_main.js', import.meta.url).pathname &&
        process.argv.length < 3
      ) {
        program.help();
      }
    });

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

  program
    .command('dev')
    .description('Start the worker in development mode')
    .addOption(
      new Option('--log-level <level>', 'Set the logging level')
        .choices(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])
        .default('debug')
        .env('LOG_LEVEL'),
    )
    .action(() => {
      const options = program.optsWithGlobals();
      opts.wsURL = options.url || opts.wsURL;
      opts.apiKey = options.apiKey || opts.apiKey;
      opts.apiSecret = options.apiSecret || opts.apiSecret;
      opts.logLevel = options.logLevel || opts.logLevel;
      runWorker({
        opts,
        production: false,
        watch: false,
      });
    });

  program
    .command('connect')
    .description('Connect to a specific room')
    .requiredOption('--room <string>', 'Room name to connect to')
    .option('--participant-identity <string>', 'Identity of user to listen to')
    .addOption(
      new Option('--log-level <level>', 'Set the logging level')
        .choices(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])
        .default('debug')
        .env('LOG_LEVEL'),
    )
    .action((...[, command]) => {
      const options = command.optsWithGlobals();
      opts.wsURL = options.url || opts.wsURL;
      opts.apiKey = options.apiKey || opts.apiKey;
      opts.apiSecret = options.apiSecret || opts.apiSecret;
      opts.logLevel = options.logLevel || opts.logLevel;
      runWorker({
        opts,
        production: false,
        watch: false,
        room: options.room,
        participantIdentity: options.participantIdentity,
      });
    });

  program.parse();
};
