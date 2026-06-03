// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

const DEFAULT_TEST_INCLUDE = ['**/*.test.ts'];

function selectedIncludes(): string[] {
  if (!process.env.LIVEKIT_TEST_SELECTION) return DEFAULT_TEST_INCLUDE;

  const selected = JSON.parse(process.env.LIVEKIT_TEST_SELECTION) as Record<string, true | string>;
  const includes = new Set<string>();

  for (const [category, target] of Object.entries(selected)) {
    const provider = target === true ? '*' : target;
    switch (category) {
      case 'unit':
        includes.add('agents/**/*.test.ts');
        break;
      case 'plugin':
        includes.add(`plugins/${provider}/src/**/*.test.ts`);
        break;
      case 'stt':
        includes.add('agents/src/stt/**/*.test.ts');
        includes.add('agents/src/inference/stt.test.ts');
        includes.add(`plugins/${provider}/src/**/stt*.test.ts`);
        break;
      case 'tts':
        includes.add('agents/src/tts/**/*.test.ts');
        includes.add('agents/src/inference/tts.test.ts');
        includes.add(`plugins/${provider}/src/**/tts*.test.ts`);
        break;
      case 'realtime':
        includes.add(`plugins/${provider}/src/**/realtime/**/*.test.ts`);
        break;
      case 'evals':
      case 'docs':
        break;
    }
  }

  return includes.size > 0 ? [...includes] : ['__no_tests__/**/*.test.ts'];
}

export default defineConfig(({ mode }) => ({
  define: {
    __PACKAGE_VERSION__: JSON.stringify(process.env.npm_package_version ?? '0.0.0-test'),
  },
  test: {
    include: selectedIncludes(),
    // it is recommended to define a name when using inline configs
    name: 'nodejs',
    environment: 'node',
    // Default timeout for unit tests (5s), integration tests override this per-suite
    testTimeout: 5_000,
    env: loadEnv(mode, process.cwd(), ''),
    setupFiles: ['./vitest.setup.ts'],
  },
}));
