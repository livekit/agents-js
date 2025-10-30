// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Command, Option } from 'commander';
import type { EventEmitter } from 'node:events';
import { initializeLogger, log } from './log.js';
import { Plugin } from './plugin.js';
import { version } from './version.js';
import { AgentServer, ServerOptions } from './worker.js';

type CliArgs = {
  opts: ServerOptions;
  production: boolean;
  watch: boolean;
  event?: EventEmitter;
  room?: string;
  participantIdentity?: string;
};

const runServer = async (args: CliArgs) => {
  initializeLogger({ pretty: !args.production, level: args.opts.logLevel });
  const logger = log();

  // though `production` is defined in ServerOptions, it will always be overridden by CLI.
  const { production: _, ...opts } = args.opts; // eslint-disable-line @typescript-eslint/no-unused-vars
  const server = new AgentServer(new ServerOptions({ production: args.production, ...opts }));

  if (args.room) {
    server.event.once('worker_registered', () => {
      logger.info(`connecting to room ${args.room}`);
      server.simulateJob(args.room!, args.participantIdentity);
    });
  }

  process.once('SIGINT', async () => {
    logger.debug('SIGINT received in CLI');
    // allow C-c C-c for force interrupt
    process.once('SIGINT', () => {
      console.log('Force exit (Ctrl+C pressed twice)');
      process.exit(130); // SIGINT exit code
    });
    if (args.production) {
      await server.drain();
    }
    await server.close();
    logger.debug('worker closed due to SIGINT.');
    process.exit(130); // SIGINT exit code
  });

  process.once('SIGTERM', async () => {
    logger.debug('SIGTERM received in CLI.');
    if (args.production) {
      await server.drain();
    }
    await server.close();
    logger.debug('worker closed due to SIGTERM.');
    process.exit(143); // SIGTERM exit code
  });

  try {
    await server.run();
  } catch {
    logger.fatal('closing worker due to error.');
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
 *   cli.runApp(new ServerOptions({ agent: import.meta.filename }));
 * }
 * ```
 */
export const runApp = (opts: ServerOptions) => {
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
    .addOption(
      new Option('--worker-token <string>', 'Internal use only')
        .env('LIVEKIT_WORKER_TOKEN')
        .hideHelp(),
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
      opts.workerToken = options.workerToken || opts.workerToken;
      runServer({
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
      opts.workerToken = options.workerToken || opts.workerToken;
      runServer({
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
      opts.workerToken = options.workerToken || opts.workerToken;
      runServer({
        opts,
        production: false,
        watch: false,
        room: options.room,
        participantIdentity: options.participantIdentity,
      });
    });

  program
    .command('download-files')
    .description('Download plugin dependency files')
    .addOption(
      new Option('--log-level <level>', 'Set the logging level')
        .choices(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])
        .default('debug')
        .env('LOG_LEVEL'),
    )
    .action(() => {
      const options = program.optsWithGlobals();
      initializeLogger({ pretty: true, level: options.logLevel });
      const logger = log();

      const downloadFiles = async () => {
        for (const plugin of Plugin.registeredPlugins) {
          logger.info(`Downloading files for ${plugin.title}`);
          try {
            await plugin.downloadFiles();
            logger.info(`Finished downloading files for ${plugin.title}`);
          } catch (error) {
            logger.error(`Failed to download files for ${plugin.title}: ${error}`);
          }
        }
      };

      downloadFiles()
        .catch((error) => {
          logger.fatal(`Error during file downloads: ${error}`);
          process.exit(1);
        })
        .finally(() => {
          process.exit(0);
        });
    });

  program.parse();
};
