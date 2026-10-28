// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import ffmpeg from 'fluent-ffmpeg';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { audioFramesFromFile } from './audio.js';

/** A mono 16-bit PCM WAV of `seconds` of silence. */
function wavBytes(seconds: number, sampleRate = 48000): Buffer {
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
  return Buffer.concat([header, Buffer.alloc(dataSize)]);
}

describe('audioFramesFromFile', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lk-audio-'));
  const wav = join(dir, 'clip.wav');
  writeFileSync(wav, wavBytes(5));

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

  it.skipIf(process.platform === 'win32')(
    'stops ffmpeg when the consumer cancels while the input is stalled',
    { timeout: 15000 },
    async () => {
      // A FIFO that delivers half a second, then stalls. Once that is read nothing is
      // left to write, so only cancelling the stream can stop ffmpeg.
      const fifo = join(dir, 'stalled.wav');
      execFileSync('mkfifo', [fifo]);
      const kill = vi.spyOn(ffmpeg.prototype, 'kill');
      const reader = audioFramesFromFile(fifo).getReader();
      const writer = await open(fifo, 'w');
      try {
        await writer.write(wavBytes(0.5));
        // drain what ffmpeg decoded until the stream goes quiet
        let next = reader.read();
        while (await Promise.race([next.then(() => true), delay(300).then(() => false)])) {
          next = reader.read();
        }
        await reader.cancel();

        expect(kill).toHaveBeenCalledWith('SIGKILL');
      } finally {
        kill.mockRestore();
        await writer.close();
      }
    },
  );

  it('still yields the whole clip when read to the end', async () => {
    let samples = 0;
    for await (const frame of audioFramesFromFile(wav)) {
      samples += frame.samplesPerChannel;
    }
    expect(samples).toBeGreaterThan(4.5 * 48000);
  });
});
