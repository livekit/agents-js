// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['**/*.test.ts'],
    // it is recommended to define a name when using inline configs
    name: 'nodejs',
    environment: 'node',
    testTimeout: 60_000,
  },
});
