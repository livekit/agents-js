// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';
import { BUILD_REVISION, FFMPEG_VERSION } from './scripts/ffmpeg/release.mjs';

export default defineConfig(({ mode }) => ({
  define: {
    __PACKAGE_VERSION__: JSON.stringify(process.env.npm_package_version ?? '0.0.0-test'),
    __FFMPEG_VERSION__: JSON.stringify(FFMPEG_VERSION),
    __FFMPEG_BUILD_REVISION__: JSON.stringify(BUILD_REVISION),
  },
  test: {
    include: ['**/*.test.ts'],
    // it is recommended to define a name when using inline configs
    name: 'nodejs',
    environment: 'node',
    // Default timeout for unit tests (5s), integration tests override this per-suite
    testTimeout: 5_000,
    env: loadEnv(mode, process.cwd(), ''),
    setupFiles: ['./vitest.setup.ts'],
  },
}));
