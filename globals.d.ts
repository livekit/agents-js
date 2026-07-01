// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/** Injected at build time by tsup via esbuild `define`. See tsup.config.ts. */
declare const __PACKAGE_NAME__: string;
declare const __PACKAGE_VERSION__: string;

/**
 * FFmpeg release coordinates injected at build time from scripts/ffmpeg/release.mjs (the
 * single source of truth). See tsup.config.ts and vitest.config.ts.
 */
declare const __FFMPEG_VERSION__: string;
declare const __FFMPEG_BUILD_REVISION__: number;
