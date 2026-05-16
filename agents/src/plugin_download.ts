// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { log } from './log.js';
import { Plugin } from './plugin.js';

type PluginDownloadFailure = {
  plugin: Plugin;
  error: unknown;
};

const formatErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** @internal */
export const formatDownloadFailureMessage = (failures: PluginDownloadFailure[]): string => {
  const pluginLabel = failures.length === 1 ? 'plugin' : 'plugins';
  const details = failures
    .map(
      ({ plugin, error }) =>
        `- ${plugin.title} (${plugin.package}@${plugin.version}): ${formatErrorMessage(error)}`,
    )
    .join('\n');

  return `Failed to download files for ${failures.length} ${pluginLabel}:\n${details}`;
};

/** @internal */
export const downloadRegisteredPluginFiles = async (): Promise<void> => {
  const logger = log();
  const failures: PluginDownloadFailure[] = [];

  for (const plugin of Plugin.registeredPlugins) {
    logger.info(`Downloading files for ${plugin.title}`);
    try {
      await plugin.downloadFiles();
      logger.info(`Finished downloading files for ${plugin.title}`);
    } catch (error) {
      failures.push({ plugin, error });
      logger.error(`Failed to download files for ${plugin.title}: ${formatErrorMessage(error)}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(formatDownloadFailureMessage(failures));
  }
};

/** @internal */
export const stringifyDownloadError = formatErrorMessage;
