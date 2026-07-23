// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Command, Option } from 'commander';
import type { EventEmitter } from 'node:events';
import { CLIClient } from './cli_client.js';
import { runConsole } from './console.js';
import { type PluginDownloadFailure, formatDownloadFailureMessage } from './download.js';
import { initializeLogger, log } from './log.js';
import { Plugin } from './plugin.js';
import { version } from './version.js';
import { AgentServer, ServerOptions } from './worker.js';

export { formatDownloadFailureMessage };

type CliArgs = {
  opts: ServerOptions;
  production: boolean;
  watch: boolean;
  event?: EventEmitter;
  room?: string;
  participantIdentity?: string;
  // Address of the driving `lk` CLI's dev channel (set by `lk agent dev`).
  cliAddr?: string;
};

const runServer = async (args: CliArgs) => {
  initializeLogger({ pretty: !args.production, level: args.opts.logLevel });
  const logger = log();

  // though `production` is defined in ServerOptions, it will always be overridden by CLI.
  const { production: _, ...opts } = args.opts; // eslint-disable-line @typescript-eslint/no-unused-vars
  const serverOptions = new ServerOptions({ ...opts, production: args.production });
  const server = new AgentServer(serverOptions);

  // When launched by `lk agent dev`, report ServerInfo over the CLI's dev channel
  // so it can surface e.g. a Cloud console link. Best-effort; never fatal.
  const cliClient = args.cliAddr
    ? new CLIClient(args.cliAddr, serverOptions.agentName, serverOptions.wsURL)
    : undefined;
  cliClient?.start();

  if (args.room) {
    server.event.once('worker_registered', () => {
      logger.info({ roomName: args.room }, 'connecting to room');
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
      try {
        await server.drain();
      } catch (e) {
        logger.error(e);
      }
    }
    cliClient?.close();
    await server.close();
    logger.debug('worker closed due to SIGINT.');
    process.exit(130); // SIGINT exit code
  });

  process.once('SIGTERM', async () => {
    logger.debug('SIGTERM received in CLI.');
    if (args.production) {
      try {
        await server.drain();
      } catch (e) {
        logger.error(e);
      }
    }
    cliClient?.close();
    await server.close();
    logger.debug('worker closed due to SIGTERM.');
    process.exit(143); // SIGTERM exit code
  });

  try {
    await server.run();
  } catch {
    logger.fatal('closing worker due to error.');
    process.exit(1);
  } finally {
    cliClient?.close();
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
  const logLevelOption = (defaultLevel: string) =>
    new Option('--log-level <level>', 'Set the logging level')
      .choices(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])
      .default(defaultLevel)
      .env('LOG_LEVEL');

  const program = new Command()
    .name('agents')
    .description('LiveKit Agents CLI')
    .version(version)
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
    .addOption(logLevelOption('info'))
    .addOption(
      new Option(
        '--simulation',
        'Run under an agent simulation: the worker load limit is disabled so runs ' +
          'can saturate the agent, and the worker HTTP server is not started. Set by `lk simulate`.',
      ).hideHelp(),
    )
    .action((...[, command]) => {
      const globalOptions = program.optsWithGlobals();
      const commandOptions = command.opts();
      opts.wsURL = globalOptions.url || opts.wsURL;
      opts.apiKey = globalOptions.apiKey || opts.apiKey;
      opts.apiSecret = globalOptions.apiSecret || opts.apiSecret;
      opts.logLevel = commandOptions.logLevel;
      opts.workerToken = globalOptions.workerToken || opts.workerToken;
      opts.simulation = commandOptions.simulation || opts.simulation;
      runServer({
        opts,
        production: true,
        watch: false,
      });
    });

  program
    .command('dev')
    .description('Start the worker in development mode')
    .addOption(logLevelOption('debug'))
    .addOption(
      // Set by `lk agent dev`: address of the CLI's dev channel the agent reports
      // ServerInfo to (agent name + URL, e.g. for a Cloud console link).
      new Option('--cli-addr <string>', 'Internal use only').hideHelp(),
    )
    .action((...[, command]) => {
      const globalOptions = program.optsWithGlobals();
      const commandOptions = command.opts();
      opts.wsURL = globalOptions.url || opts.wsURL;
      opts.apiKey = globalOptions.apiKey || opts.apiKey;
      opts.apiSecret = globalOptions.apiSecret || opts.apiSecret;
      opts.logLevel = commandOptions.logLevel;
      opts.workerToken = globalOptions.workerToken || opts.workerToken;
      process.env.LIVEKIT_DEV_MODE = '1';
      runServer({
        opts,
        production: false,
        watch: false,
        cliAddr: commandOptions.cliAddr,
      });
    });

  program
    .command('connect')
    .description('Connect to a specific room')
    .requiredOption('--room <string>', 'Room name to connect to')
    .option('--participant-identity <string>', 'Identity of user to listen to')
    .addOption(logLevelOption('info'))
    .action((...[, command]) => {
      const globalOptions = program.optsWithGlobals();
      const commandOptions = command.opts();
      opts.wsURL = globalOptions.url || opts.wsURL;
      opts.apiKey = globalOptions.apiKey || opts.apiKey;
      opts.apiSecret = globalOptions.apiSecret || opts.apiSecret;
      opts.logLevel = commandOptions.logLevel;
      opts.workerToken = globalOptions.workerToken || opts.workerToken;
      process.env.LIVEKIT_DEV_MODE = '1';
      runServer({
        opts,
        production: false,
        watch: false,
        room: commandOptions.room,
        participantIdentity: commandOptions.participantIdentity,
      });
    });

  program
    .command('console')
    .description('Run the agent in-process attached to a local broker over TCP')
    .requiredOption('--connect-addr <addr>', 'host:port of the broker TCP socket')
    .option('--record', 'save the session report locally', false)
    .addOption(logLevelOption('debug'))
    .action((...[, command]) => {
      const commandOptions = command.opts();
      opts.logLevel = commandOptions.logLevel;
      initializeLogger({ pretty: true, level: opts.logLevel });
      process.env.LIVEKIT_DEV_MODE = '1';
      runConsole({
        agentPath: opts.agent,
        connectAddr: commandOptions.connectAddr,
        record: commandOptions.record === true,
      }).catch((error) => {
        log().fatal({ 'lk.pii.error': error }, 'console mode failed');
        process.exit(1);
      });
    });

  program
    .command('download-files')
    .description('Download plugin dependency files')
    .addOption(logLevelOption('debug'))
    .action((...[, command]) => {
      const commandOptions = command.opts();
      initializeLogger({ pretty: true, level: commandOptions.logLevel });
      const logger = log();

      logger.warn(
        'Invoking the download-files command via cli.runApp() is deprecated as of 1.4.4. ' +
          'Use the livekit-agents command included with the @livekit/agents package instead, e.g. ' +
          '`npx livekit-agents download-files`.',
      );

      const downloadFiles = async () => {
        const failures: PluginDownloadFailure[] = [];

        for (const plugin of Plugin.registeredPlugins) {
          logger.info({ plugin: plugin.title }, 'Downloading plugin files');
          try {
            await plugin.downloadFiles();
            logger.info({ plugin: plugin.title }, 'Finished downloading plugin files');
          } catch (error) {
            failures.push({ plugin, error });
            logger.error(
              { 'lk.pii.error': error, plugin: plugin.title },
              'failed to download plugin files',
            );
          }
        }

        if (failures.length > 0) {
          throw new Error(formatDownloadFailureMessage(failures));
        }
      };

      downloadFiles()
        .then(() => {
          process.exit(0);
        })
        .catch((error) => {
          logger.fatal({ 'lk.pii.error': error }, 'error during file downloads');
          process.exit(1);
        });
    });

  program.parse();
};
