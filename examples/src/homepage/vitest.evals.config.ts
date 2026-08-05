// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

export default defineConfig(({ mode }) => ({
  root: new URL('../../..', import.meta.url).pathname,
  define: {
    __PACKAGE_VERSION__: JSON.stringify('0.0.0-test'),
  },
  test: {
    include: ['examples/src/homepage/tests/evals/**/*.eval.test.ts'],
    environment: 'node',
    testTimeout: 180_000,
    env: loadEnv(mode, process.cwd(), ''),
    setupFiles: ['./vitest.setup.ts'],
  },
}));
