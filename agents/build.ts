// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import dts from 'bun-plugin-dts';

await Bun.build({
  entrypoints: ['./src/index.ts', './src/tts/index.ts', './src/stt/index.ts', './src/cli.ts'],
  outdir: './dist',
  target: 'bun', // https://github.com/oven-sh/bun/blob/main/src/bundler/bundle_v2.zig#L2667
  sourcemap: 'external',
  root: './src',
  plugins: [dts()],
});
