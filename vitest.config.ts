// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

export default defineConfig(({ mode }) => ({
  test: {
    include: ['**/*.test.ts'],
    // it is recommended to define a name when using inline configs
    name: 'nodejs',
    environment: 'node',
    // Default timeout for unit tests (5s), integration tests override this per-suite
    testTimeout: 5_000,
    env: loadEnv(mode, process.cwd(), ''),
  },
}));
