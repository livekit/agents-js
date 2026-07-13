// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioFrame } from '@livekit/rtc-node';
import { describe, expect, it } from 'vitest';
import { KrispLicenseFrameProcessor } from './krisp.js';

class IdentitySession {
  process(chunkIn: Int16Array): Int16Array {
    return new Int16Array(chunkIn);
  }
}

function makeProcessor(sampleRate: number, chunkSamples: number): KrispLicenseFrameProcessor {
  return KrispLicenseFrameProcessor.createForTest({
    session: new IdentitySession(),
    sampleRate,
    chunkSamples,
  });
}

function feed(
  proc: KrispLicenseFrameProcessor,
  sampleRate: number,
  frameSizes: number[],
): [Int16Array, Int16Array] {
  let counter = 1;
  const fed: Int16Array[] = [];
  const out: Int16Array[] = [];
  for (const frameSize of frameSizes) {
    const inArr = new Int16Array(frameSize);
    for (let i = 0; i < frameSize; i += 1) {
      inArr[i] = counter;
      counter += 1;
    }
    fed.push(inArr);
    const processed = proc.process(new AudioFrame(inArr, sampleRate, 1, frameSize));
    out.push(processed.data);
  }
  return [concat(fed), concat(out)];
}

function concat(arrays: Int16Array[]): Int16Array {
  const total = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const out = new Int16Array(total);
  let offset = 0;
  for (const arr of arrays) {
    out.set(arr, offset);
    offset += arr.length;
  }
  return out;
}

function interiorZeros(stream: Int16Array): number {
  let firstNonZero = -1;
  for (let i = 0; i < stream.length; i += 1) {
    if (stream[i] !== 0) {
      firstNonZero = i;
      break;
    }
  }
  if (firstNonZero === -1) {
    return 0;
  }
  let zeros = 0;
  for (let i = firstNonZero; i < stream.length; i += 1) {
    if (stream[i] === 0) {
      zeros += 1;
    }
  }
  return zeros;
}

describe('Krisp license frame buffering', () => {
  it('does not inject interior silence when frame is smaller than chunk', () => {
    const sampleRate = 16000;
    const chunk = 160;
    const proc = makeProcessor(sampleRate, chunk);
    const [inStream, outStream] = feed(
      proc,
      sampleRate,
      Array.from({ length: 40 }, () => 100),
    );

    expect(interiorZeros(outStream)).toBe(0);
    expect(outStream.length).toBeGreaterThan(0);
    expect(outStream).toEqual(inStream.slice(0, outStream.length));
  });

  it('does not inject interior silence with variable frame sizes', () => {
    const sampleRate = 16000;
    const chunk = 160;
    const proc = makeProcessor(sampleRate, chunk);
    const sizes = [137, 53, 200, 80, 160, 45, 300, 10, 90, 160];
    const [, outStream] = feed(proc, sampleRate, Array.from({ length: 4 }, () => sizes).flat());

    expect(interiorZeros(outStream)).toBe(0);
  });

  it('passes through exactly when frame equals chunk', () => {
    const sampleRate = 16000;
    const chunk = 160;
    const proc = makeProcessor(sampleRate, chunk);
    const [inStream, outStream] = feed(
      proc,
      sampleRate,
      Array.from({ length: 20 }, () => chunk),
    );

    expect(outStream).toEqual(inStream);
  });
});
