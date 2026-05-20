// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from 'tsdown';
import defaults from '../../tsdown.config.ts';

export default defineConfig({
  ...defaults,
  entry: ['src/**/*.ts', '!src/**/*.test.ts'],
  format: 'cjs',
  clean: false,
  dts: false,
  target: false,
});
