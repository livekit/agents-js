#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Command, Option } from 'commander';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeLogger, log } from './log.js';
import { downloadRegisteredPluginFiles, stringifyDownloadError } from './plugin_download.js';
import { version } from './version.js';

const LIVEKIT_SCOPE = '@livekit';
const PLUGIN_PACKAGE_PREFIX = 'agents-plugin-';

const collectNodeModulesDirs = (): string[] => {
  const starts = [process.cwd(), path.dirname(fileURLToPath(import.meta.url))];
  const dirs = new Set<string>();

  for (const start of starts) {
    let current = path.resolve(start);

    while (true) {
      dirs.add(path.join(current, 'node_modules'));

      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }

  return [...dirs];
};

const discoverInstalledPluginPackages = async (): Promise<string[]> => {
  const packages = new Set<string>();

  for (const nodeModulesDir of collectNodeModulesDirs()) {
    let entries;
    try {
      entries = await readdir(path.join(nodeModulesDir, LIVEKIT_SCOPE), { withFileTypes: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') continue;
      throw error;
    }

    for (const entry of entries) {
      if (!entry.name.startsWith(PLUGIN_PACKAGE_PREFIX)) continue;
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;

      packages.add(`${LIVEKIT_SCOPE}/${entry.name}`);
    }
  }

  return [...packages].sort();
};

const discoverAndImportPlugins = async (): Promise<string[]> => {
  const logger = log();
  const pluginPackages = await discoverInstalledPluginPackages();

  if (pluginPackages.length === 0) {
    logger.warn('No @livekit/agents-plugin-* packages found; nothing to download');
    return [];
  }

  for (const packageName of pluginPackages) {
    try {
      await import(packageName);
    } catch (error) {
      logger.warn(`Failed to import ${packageName}: ${stringifyDownloadError(error)}`);
    }
  }

  return pluginPackages;
};

const logLevelOption = (defaultLevel: string) =>
  new Option('--log-level <level>', 'Set the logging level')
    .choices(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])
    .default(defaultLevel)
    .env('LOG_LEVEL');

const program = new Command()
  .name('livekit-agents')
  .description('LiveKit Agents utilities')
  .version(version)
  .action(() => {
    if (process.argv.length < 3) {
      program.help();
    }
  });

program
  .command('download-files')
  .description('Discover installed @livekit/agents-plugin-* packages and download their files')
  .addOption(logLevelOption('debug'))
  .action(async (...[, command]) => {
    const commandOptions = command.opts();
    initializeLogger({ pretty: true, level: commandOptions.logLevel });
    const logger = log();

    try {
      const pluginPackages = await discoverAndImportPlugins();
      logger.info(
        `Discovered ${pluginPackages.length} plugin package(s): ${pluginPackages.join(', ') || '(none)'}`,
      );
      await downloadRegisteredPluginFiles();
      process.exit(0);
    } catch (error) {
      logger.fatal(`Error during file downloads: ${error}`);
      process.exit(1);
    }
  });

program.parseAsync().catch((error: unknown) => {
  console.error(stringifyDownloadError(error));
  process.exit(1);
});
