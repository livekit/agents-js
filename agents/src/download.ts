// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { initializeLogger, log, loggerOptions } from './log.js';
import { Plugin } from './plugin.js';

/** @internal */
export type PluginDownloadFailure = {
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

const PLUGIN_PREFIX = 'agents-plugin-';
// `@livekit/agents-plugins-test` (pluralized) is a private test-only mock used in unit tests.
// It registers nothing useful in production contexts and importing it would be wasted work.
const SKIP_PACKAGES = new Set<string>(['@livekit/agents-plugins-test']);

const collectLivekitDirs = (startDir: string): string[] => {
  const dirs: string[] = [];
  let current = path.resolve(startDir);
  while (true) {
    const candidate = path.join(current, 'node_modules', '@livekit');
    try {
      if (fs.statSync(candidate).isDirectory()) {
        dirs.push(candidate);
      }
    } catch {
      // not present at this level, skip
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return dirs;
};

/** @internal */
export type DiscoveredPlugin = {
  name: string;
  path: string;
};

// Walks the `exports` field of a package.json looking for the ESM entry. We must NOT use
// `createRequire().resolve()` here — that picks the `require` (CJS) condition, which when
// imported back via dynamic `import()` lands in a separate module instance of `@livekit/agents`
// (ESM vs CJS dual-package hazard). The plugin would then call `Plugin.registerPlugin` on a
// different class than the bin reads, and we'd see zero registrations.
const readEsmEntry = (pkgPath: string): string => {
  const raw = fs.readFileSync(path.join(pkgPath, 'package.json'), 'utf-8');
  const pkgJson = JSON.parse(raw) as {
    main?: string;
    module?: string;
    exports?: unknown;
  };

  const pickFromExports = (exp: unknown): string | undefined => {
    if (typeof exp === 'string') return exp;
    if (!exp || typeof exp !== 'object') return undefined;
    const obj = exp as Record<string, unknown>;
    // `exports: { ".": ... }` vs sugared `exports: { import: ..., require: ... }`
    const dot = '.' in obj ? obj['.'] : obj;
    if (typeof dot === 'string') return dot;
    if (!dot || typeof dot !== 'object') return undefined;
    const dotObj = dot as Record<string, unknown>;
    const importCond = dotObj.import;
    if (typeof importCond === 'string') return importCond;
    if (importCond && typeof importCond === 'object') {
      const def = (importCond as Record<string, unknown>).default;
      if (typeof def === 'string') return def;
    }
    return undefined;
  };

  const entry = pickFromExports(pkgJson.exports) ?? pkgJson.module ?? pkgJson.main;
  if (!entry) {
    throw new Error(`no ESM entry found in ${pkgPath}/package.json`);
  }
  return path.resolve(pkgPath, entry);
};

/** @internal */
export const discoverPluginPackages = (startDir: string = process.cwd()): DiscoveredPlugin[] => {
  const seen = new Set<string>();
  const out: DiscoveredPlugin[] = [];
  for (const livekitDir of collectLivekitDirs(startDir)) {
    let entries: string[];
    try {
      entries = fs.readdirSync(livekitDir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.startsWith(PLUGIN_PREFIX)) continue;
      const name = `@livekit/${entry}`;
      if (SKIP_PACKAGES.has(name) || seen.has(name)) continue;
      const pkgPath = path.join(livekitDir, entry);
      try {
        if (!fs.statSync(pkgPath).isDirectory()) continue;
      } catch {
        continue;
      }
      seen.add(name);
      out.push({ name, path: pkgPath });
    }
  }
  return out;
};

/** @internal */
export const main = async (cwd: string = process.cwd()): Promise<number> => {
  if (!loggerOptions()) {
    initializeLogger({ pretty: true, level: 'info' });
  }
  const logger = log();

  const packages = discoverPluginPackages(cwd);
  if (packages.length === 0) {
    logger.warn('no @livekit/agents-plugin-* packages found in node_modules — nothing to download');
    return 0;
  }
  logger.info(
    { pluginCount: packages.length, plugins: packages.map((p) => p.name) },
    'discovered plugin packages',
  );

  let importFailures = 0;
  for (const pkg of packages) {
    try {
      const entryAbs = readEsmEntry(pkg.path);
      await import(pathToFileURL(entryAbs).href);
    } catch (error) {
      importFailures += 1;
      logger.error({ 'lk.pii.error': error, package: pkg.name }, 'failed to import plugin package');
    }
  }

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
    logger.fatal(
      { 'lk.pii.error': formatDownloadFailureMessage(failures) },
      'plugin file downloads failed',
    );
  }
  return failures.length > 0 || importFailures > 0 ? 1 : 0;
};
