#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Command, Option } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runAgentServer } from '../cli.js';
import { main as downloadFilesMain } from '../download.js';
import { version } from '../version.js';
import { AgentServer } from '../worker.js';

const DEFAULT_ENTRYPOINTS = [
  'main.js',
  'app.js',
  'agent.js',
  'src/main.js',
  'src/app.js',
  'src/agent.js',
  'main.ts',
  'app.ts',
  'agent.ts',
  'src/main.ts',
  'src/app.ts',
  'src/agent.ts',
];

function getEntrypointPath(entrypoint?: string): string {
  if (entrypoint) {
    const resolved = path.resolve(entrypoint);
    if (!fs.existsSync(resolved)) {
      throw new Error(`Path does not exist ${entrypoint}`);
    }
    return resolved;
  }

  for (const candidate of DEFAULT_ENTRYPOINTS) {
    const resolved = path.resolve(candidate);
    if (fs.existsSync(resolved)) {
      return resolved;
    }
  }

  throw new Error('Could not find a default file to run, please provide an explicit path');
}

function serverFromExports(exports: Record<string, unknown>): AgentServer | undefined {
  for (const preferredName of ['app', 'server', 'agent']) {
    const value = exports[preferredName];
    if (value instanceof AgentServer) {
      return value;
    }
  }

  const servers = Object.values(exports).filter((value): value is AgentServer => {
    return value instanceof AgentServer;
  });
  if (servers.length === 1) {
    return servers[0];
  }

  return undefined;
}

async function discoverAgentServer(entrypoint?: string): Promise<AgentServer> {
  const entrypointPath = getEntrypointPath(entrypoint);
  const mod = (await import(pathToFileURL(entrypointPath).href)) as Record<string, unknown>;
  const server =
    serverFromExports(mod) ||
    (typeof mod.default === 'object' && mod.default !== null
      ? serverFromExports(mod.default as Record<string, unknown>)
      : undefined);

  if (!server) {
    throw new Error('Could not find AgentServer in module, try to export the `server` variable');
  }

  return server;
}

type RunOptions = {
  apiKey?: string;
  apiSecret?: string;
  logLevel: string;
  url?: string;
  workerToken?: string;
};

async function runDiscoveredServer({
  entrypoint,
  production,
  opts,
}: {
  entrypoint?: string;
  production: boolean;
  opts: RunOptions;
}): Promise<void> {
  const server = await discoverAgentServer(entrypoint);
  server.updateOptions({
    apiKey: opts.apiKey,
    apiSecret: opts.apiSecret,
    logLevel: opts.logLevel,
    workerToken: opts.workerToken,
    wsURL: opts.url,
  });
  await runAgentServer({ logLevel: opts.logLevel, production, server, watch: false });
}

const program = new Command()
  .name('livekit-agents')
  .description('LiveKit Agents standalone CLI')
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
  );

const addLogLevelOption = (command: Command, defaultLevel: string) => {
  return command.addOption(
    new Option('--log-level <level>', 'Set the logging level')
      .choices(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])
      .default(defaultLevel)
      .env('LOG_LEVEL'),
  );
};

addLogLevelOption(
  program.command('start [entrypoint]').description('Start the worker'),
  'info',
).action(async (entrypoint: string | undefined, command: Command) => {
  const opts = { ...program.opts(), ...command.opts() } as RunOptions;
  await runDiscoveredServer({ entrypoint, production: true, opts });
});

addLogLevelOption(
  program
    .command('console [entrypoint]')
    .description('Run the worker in console mode')
    .requiredOption('--connect-addr <host:port>', 'TCP console server address')
    .option('--record', 'Record the console session', false),
  'debug',
).action(async () => {
  throw new Error('TCP console mode is not available in agents-js yet');
});

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
