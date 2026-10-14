// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { audioFramesFromFile } from './audio.js';

/** A mono 16-bit PCM WAV of `seconds` of silence. */
function writeWav(path: string, seconds: number, sampleRate = 48000): void {
  const dataSize = seconds * sampleRate * 2;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);
  writeFileSync(path, Buffer.concat([header, Buffer.alloc(dataSize)]));
}

describe('audioFramesFromFile', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lk-audio-'));
  const wav = join(dir, 'clip.wav');
  writeWav(wav, 5);

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('does not leave unhandled rejections when the consumer stops early', async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on('unhandledRejection', onRejection);
    try {
      for await (const _frame of audioFramesFromFile(wav)) {
        break; // like BackgroundAudioPlayer when its PlayHandle is stopped
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    } finally {
      process.off('unhandledRejection', onRejection);
    }

    expect(rejections).toEqual([]);
  });

  it('still yields the whole clip when read to the end', async () => {
    let samples = 0;
    for await (const frame of audioFramesFromFile(wav)) {
      samples += frame.samplesPerChannel;
    }
    expect(samples).toBeGreaterThan(4.5 * 48000);
  });
});
