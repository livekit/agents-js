// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { FFMPEG_PATH_ENV, parseChecksums, resolveFfmpegPath, verifyChecksum } from './ffmpeg.js';

describe('ffmpeg path resolution', () => {
  afterEach(() => {
    delete process.env[FFMPEG_PATH_ENV];
  });

  it('prefers the LIVEKIT_FFMPEG_PATH override', () => {
    process.env[FFMPEG_PATH_ENV] = '/custom/ffmpeg';
    expect(resolveFfmpegPath()).toBe('/custom/ffmpeg');
  });

  it('returns undefined when nothing is available', () => {
    // No override set and the bundled binary is not present in the test environment.
    expect(resolveFfmpegPath()).toBeUndefined();
  });
});

describe('parseChecksums', () => {
  it('parses sha256sum-style lines (two-space and binary-marker forms)', () => {
    const map = parseChecksums(
      ['a'.repeat(64) + '  ffmpeg-linux-x64.gz', 'b'.repeat(64) + ' *ffmpeg-win32-x64.gz', ''].join(
        '\n',
      ),
    );
    expect(map.get('ffmpeg-linux-x64.gz')).toBe('a'.repeat(64));
    expect(map.get('ffmpeg-win32-x64.gz')).toBe('b'.repeat(64));
  });

  it('ignores malformed lines', () => {
    expect(parseChecksums('not a checksum line\n').size).toBe(0);
  });
});

describe('verifyChecksum', () => {
  const data = Buffer.from('hello ffmpeg');
  const digest = createHash('sha256').update(data).digest('hex');

  it('passes when the digest matches', () => {
    expect(() => verifyChecksum(data, digest, 'asset.gz')).not.toThrow();
  });

  it('throws on mismatch', () => {
    expect(() => verifyChecksum(data, 'deadbeef', 'asset.gz')).toThrow(/checksum mismatch/);
  });
});
