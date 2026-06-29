// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
// Postinstall hook: pre-fetch the bundled LGPL ffmpeg binary for the current platform so
// agents work out of the box. This is best-effort — it must never fail the install:
//
//  - In a source checkout (monorepo dev) `dist/` may not exist yet; we skip silently and the
//    binary is fetched later, on first use or via `npx livekit-agents download-files`.
//  - With `--ignore-scripts`, or if the download fails (offline, locked-down CI), the runtime
//    falls back to `LIVEKIT_FFMPEG_PATH` / `ffmpeg` on PATH, or downloads lazily on first use.
//
// Set LIVEKIT_SKIP_FFMPEG_DOWNLOAD=1 to opt out entirely.
import { createRequire } from 'node:module';

if (process.env.LIVEKIT_SKIP_FFMPEG_DOWNLOAD) {
  process.exit(0);
}

const require = createRequire(import.meta.url);

try {
  // Resolve the built modules relative to this package; absent in an unbuilt source checkout.
  const { initializeLogger } = await import(require.resolve('../dist/log.js'));
  initializeLogger({ pretty: true, level: 'info' });
  const { downloadFfmpeg } = await import(require.resolve('../dist/ffmpeg.js'));
  await downloadFfmpeg();
} catch (err) {
  const message = err && err.code === 'MODULE_NOT_FOUND' ? 'package not built yet' : err?.message;
  console.warn(
    `[livekit-agents] skipping ffmpeg pre-download (${message}); ` +
      'it will be fetched on first use or via `npx livekit-agents download-files`.',
  );
}

process.exit(0);
