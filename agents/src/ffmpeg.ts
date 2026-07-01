// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import ffmpeg from 'fluent-ffmpeg';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { log } from './log.js';

// FFmpeg release coordinates, injected at build time by esbuild `define` from the single
// source of truth at scripts/ffmpeg/release.mjs (see tsup.config.ts / vitest.config.ts).
const FFMPEG_VERSION = __FFMPEG_VERSION__;
const BUILD_REVISION = __FFMPEG_BUILD_REVISION__;
const RELEASE_TAG = `ffmpeg-bin/v${FFMPEG_VERSION}-${BUILD_REVISION}`;

/** Env var allowing users to point at their own ffmpeg binary, bypassing the bundled one. */
export const FFMPEG_PATH_ENV = 'LIVEKIT_FFMPEG_PATH';
/** Env var to override the release download base URL (mirrors, air-gapped installs, tests). */
export const FFMPEG_BASE_URL_ENV = 'LIVEKIT_FFMPEG_BASE_URL';

const releaseBaseUrl = (): string =>
  process.env[FFMPEG_BASE_URL_ENV]?.replace(/\/$/, '') ??
  `https://github.com/livekit/agents-js/releases/download/${RELEASE_TAG}`;

const SUPPORTED_TARGETS = new Set([
  'darwin-arm64',
  'darwin-x64',
  'linux-x64',
  'linux-arm64',
  'win32-x64',
]);

const currentTarget = (): string | null => {
  const target = `${process.platform}-${process.arch}`;
  return SUPPORTED_TARGETS.has(target) ? target : null;
};

const binaryFileName = (): string => (process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');

// `.ffmpeg/` lives at the package root, next to `dist/`. This file is built to
// `dist/ffmpeg.js`, so the package root is one directory up.
const bundleDir = (): string =>
  path.join(fileURLToPath(new URL('.', import.meta.url)), '..', '.ffmpeg');

const bundledBinaryPath = (): string => path.join(bundleDir(), binaryFileName());

/**
 * Resolve the ffmpeg binary path synchronously, without downloading:
 * 1. `LIVEKIT_FFMPEG_PATH` env override, if set
 * 2. the bundled LGPL binary, if already downloaded
 * 3. `undefined` (caller may fall back to `ffmpeg` on PATH)
 */
export const resolveFfmpegPath = (): string | undefined => {
  const override = process.env[FFMPEG_PATH_ENV];
  if (override) {
    return override;
  }
  const bundled = bundledBinaryPath();
  if (fs.existsSync(bundled)) {
    return bundled;
  }
  return undefined;
};

/** @internal */
export const verifyChecksum = (data: Buffer, expectedHex: string, assetName: string): void => {
  const actual = createHash('sha256').update(data).digest('hex');
  if (actual !== expectedHex) {
    throw new Error(`checksum mismatch for ${assetName}: expected ${expectedHex}, got ${actual}`);
  }
};

const fetchBuffer = async (url: string): Promise<Buffer> => {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) {
    throw new Error(`failed to download ${url}: HTTP ${res.status} ${res.statusText}`);
  }
  return Buffer.from(await res.arrayBuffer());
};

/** @internal Parse a `sha256sum`-style file into a filename→hash map. */
export const parseChecksums = (text: string): Map<string, string> => {
  const map = new Map<string, string>();
  for (const line of text.split('\n')) {
    const match = line.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/i);
    if (match) {
      map.set(match[2]!, match[1]!.toLowerCase());
    }
  }
  return map;
};

/**
 * Download, verify, and unpack the bundled LGPL ffmpeg binary for the current platform.
 * Writes atomically to `.ffmpeg/`. Returns the binary path, or `null` on an unsupported
 * platform. Safe to call repeatedly — a no-op if the binary is already present.
 */
export const downloadFfmpeg = async (force = false): Promise<string | null> => {
  const logger = log();
  const target = currentTarget();
  if (!target) {
    logger.warn(
      `no prebuilt ffmpeg binary for ${process.platform}-${process.arch}; ` +
        `set ${FFMPEG_PATH_ENV} or ensure ffmpeg is on PATH`,
    );
    return null;
  }

  const dest = bundledBinaryPath();
  if (!force && fs.existsSync(dest)) {
    return dest;
  }

  const baseUrl = releaseBaseUrl();
  const assetName = `ffmpeg-${target}.gz`;
  const assetUrl = `${baseUrl}/${assetName}`;
  logger.info(`downloading LGPL ffmpeg ${FFMPEG_VERSION} for ${target} from ${assetUrl}`);

  const [gzipped, checksumsText] = await Promise.all([
    fetchBuffer(assetUrl),
    fetchBuffer(`${baseUrl}/checksums.sha256`).then((b) => b.toString('utf-8')),
  ]);

  const expected = parseChecksums(checksumsText).get(assetName);
  if (!expected) {
    throw new Error(`checksums.sha256 has no entry for ${assetName}`);
  }
  verifyChecksum(gzipped, expected, assetName);

  const binary = gunzipSync(gzipped);
  await fsp.mkdir(bundleDir(), { recursive: true });
  // Write to a temp file then rename so concurrent installs never observe a partial binary.
  const tmp = path.join(bundleDir(), `.${binaryFileName()}.${process.pid}.tmp`);
  await fsp.writeFile(tmp, binary, { mode: 0o755 });
  await fsp.rename(tmp, dest);
  logger.info(`ffmpeg installed to ${dest}`);
  return dest;
};

/**
 * Ensure an ffmpeg binary is available and return its path, downloading the bundled LGPL
 * build if necessary. Resolution order: `LIVEKIT_FFMPEG_PATH` → bundled binary → download →
 * `ffmpeg` on PATH. Memoized so the download happens at most once per process.
 */
let ensurePromise: Promise<string> | undefined;
export const ensureFfmpeg = (): Promise<string> => {
  if (!ensurePromise) {
    ensurePromise = (async () => {
      const resolved = resolveFfmpegPath();
      if (resolved) {
        return resolved;
      }
      const downloaded = await downloadFfmpeg().catch((err) => {
        log().error({ err }, 'failed to download bundled ffmpeg; falling back to PATH');
        return null;
      });
      if (downloaded) {
        return downloaded;
      }
      // Last resort: a bare command name makes fluent-ffmpeg resolve `ffmpeg` from PATH.
      log().warn(`using \`ffmpeg\` from PATH; set ${FFMPEG_PATH_ENV} to use a specific binary`);
      return 'ffmpeg';
    })();
  }
  return ensurePromise;
};

/**
 * Ensure ffmpeg is available and register its path with fluent-ffmpeg. Call this (and await
 * it) before invoking `ffmpeg(...)`. Memoized — the underlying resolution/download runs once.
 */
let configurePromise: Promise<void> | undefined;
export const configureFfmpeg = (): Promise<void> => {
  if (!configurePromise) {
    configurePromise = ensureFfmpeg().then((binaryPath) => {
      ffmpeg.setFfmpegPath(binaryPath);
    });
  }
  return configurePromise;
};
