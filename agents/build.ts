// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import dts from 'bun-plugin-dts';

await Bun.build({
  entrypoints: ['./src/index.ts'],
  outdir: './dist',
  target: 'node',
  sourcemap: 'external',
  root: './src',
  plugins: [dts()],
});
