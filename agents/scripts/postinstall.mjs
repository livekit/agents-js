// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
// Best-effort pre-fetch of the bundled LGPL ffmpeg binary. Must never fail the install: if
// dist/ isn't built yet (source checkout), scripts are disabled, or the download fails, the
// binary is fetched later on first use or via `livekit-agents download-files`. Set
// LIVEKIT_SKIP_FFMPEG_DOWNLOAD=1 to opt out.
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
