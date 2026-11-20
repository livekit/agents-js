// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loopAudioFramesFromFile } from './audio.js';

describe('loopAudioFramesFromFile', () => {
  it('ends when the file decodes no frames', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'loop-audio-')), 'pointer.mp3');
    writeFileSync(path, 'version https://git-lfs.github.com/spec/v1\n');

    const frames = [];
    for await (const frame of loopAudioFramesFromFile(path)) frames.push(frame);
    expect(frames).toEqual([]);
  }, 10_000);
});
