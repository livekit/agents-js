// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { getFfmpegPath } from '@livekit/av';
import ffmpeg from 'fluent-ffmpeg';
import { log, loggerOptions } from './log.js';

/** Env var allowing users to point at their own ffmpeg binary, bypassing the bundled one. */
export const FFMPEG_PATH_ENV = 'LIVEKIT_FFMPEG_PATH';

/**
 * Resolve the ffmpeg binary path:
 * 1. `LIVEKIT_FFMPEG_PATH` env override, if set
 * 2. the bundled LGPL binary from the platform-specific `@livekit/av-*` package
 * 3. `undefined` (caller may fall back to `ffmpeg` on PATH)
 */
export const resolveFfmpegPath = (): string | undefined =>
  process.env[FFMPEG_PATH_ENV] || getFfmpegPath();

/**
 * Register the resolved ffmpeg binary with fluent-ffmpeg. Call before invoking
 * `ffmpeg(...)`. Memoized — resolution runs once per process.
 */
let configured = false;
export const configureFfmpeg = (): void => {
  if (configured) {
    return;
  }
  configured = true;
  const resolved = resolveFfmpegPath();
  if (resolved) {
    ffmpeg.setFfmpegPath(resolved);
    return;
  }
  // No prebuilt binary for this platform (e.g. musl libc) or optional deps were skipped;
  // leave fluent-ffmpeg's default (`ffmpeg` on PATH). This runs at module-import time,
  // possibly before initializeLogger() — fall back to console in that case.
  const message =
    `no bundled ffmpeg binary for ${process.platform}-${process.arch}; ` +
    `using \`ffmpeg\` from PATH; set ${FFMPEG_PATH_ENV} to use a specific binary`;
  if (loggerOptions()) {
    log().warn(message);
  } else {
    console.warn(`[livekit-agents] ${message}`);
  }
};
