// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

// Single source of truth for the LiveKit-built LGPL FFmpeg binaries.
//
// To upgrade FFmpeg: open a PR bumping FFMPEG_VERSION (and reset BUILD_REVISION to 1),
// merge it, then run the `Build FFmpeg binaries` GitHub Action (workflow_dispatch). The
// action reads these values, builds the binaries for every platform, and publishes them
// to a GitHub Release tagged `${RELEASE_TAG}`. Bump BUILD_REVISION (keeping the same
// FFMPEG_VERSION) to re-release with a fixed build recipe without changing FFmpeg itself.
//
// This file is the ONLY place these values live: the build workflow imports it, the
// tsup/vitest configs inject the values into the @livekit/agents bundle via esbuild
// `define`, and the runtime resolver reads those injected values to locate the release.

/** FFmpeg release to build/download (matches an `n<version>` tag at git.ffmpeg.org). */
export const FFMPEG_VERSION = '7.1.5';

/** libopus version statically linked into the build (the only external codec library). */
export const OPUS_VERSION = '1.5.2';

/** Bump when re-releasing the same FFmpeg version with a changed build recipe. */
export const BUILD_REVISION = 1;

/** GitHub Release tag the binaries are published under. */
export const RELEASE_TAG = `ffmpeg-bin/v${FFMPEG_VERSION}-${BUILD_REVISION}`;

/**
 * Platforms we build for, keyed by `${process.platform}-${process.arch}`. Windows ships
 * `ffmpeg.exe`; everything else ships `ffmpeg`.
 */
export const SUPPORTED_TARGETS = [
  'darwin-arm64',
  'darwin-x64',
  'linux-x64',
  'linux-arm64',
  'win32-x64',
];

/** Gzipped binary asset name for a target, e.g. `ffmpeg-darwin-arm64.gz`. */
export function assetName(target) {
  return `ffmpeg-${target}.gz`;
}
