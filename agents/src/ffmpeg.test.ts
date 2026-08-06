// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import * as fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { FFMPEG_PATH_ENV, resolveFfmpegPath } from './ffmpeg.js';

describe('ffmpeg path resolution', () => {
  afterEach(() => {
    delete process.env[FFMPEG_PATH_ENV];
  });

  it('prefers the LIVEKIT_FFMPEG_PATH override over the bundled binary', () => {
    process.env[FFMPEG_PATH_ENV] = '/custom/ffmpeg';
    expect(resolveFfmpegPath()).toBe('/custom/ffmpeg');
  });

  it('resolves the @livekit/av bundled binary on supported platforms', () => {
    const resolved = resolveFfmpegPath();
    // Supported dev/CI platforms always have the platform package installed.
    expect(resolved).toBeDefined();
    expect(fs.existsSync(resolved!)).toBe(true);
  });
});
