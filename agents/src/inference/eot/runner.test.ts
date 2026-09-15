// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as warmup from '../_warmup.js';
import EotRunner from './runner.js';

describe('EotRunner', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('initializes the native EOT model and predicts on decoded PCM', async () => {
    const received: Int16Array[] = [];
    const fakeMod = {
      initEot: vi.fn(),
      initVad: vi.fn(),
      createVad: vi.fn(),
      VAD_WINDOW_SAMPLES: 512,
      predict: vi.fn(async (pcm: Int16Array) => {
        received.push(pcm);
        return 0.83;
      }),
    };
    vi.spyOn(warmup, '_getLocalInferenceModule').mockReturnValue(
      fakeMod as unknown as ReturnType<typeof warmup._getLocalInferenceModule>,
    );

    const runner = new EotRunner();
    await runner.initialize();
    expect(fakeMod.initEot).toHaveBeenCalledOnce();

    // 4 samples of s16le PCM → base64
    const samples = Int16Array.from([1, -2, 3, -4]);
    const pcm = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength).toString(
      'base64',
    );

    const out = await runner.run({ pcm });
    expect(out.probability).toBe(0.83);
    expect(out.inferenceDurationMs).toBeGreaterThanOrEqual(0);

    // the runner decoded the base64 back to the same samples
    expect(received).toHaveLength(1);
    expect(Array.from(received[0]!)).toEqual([1, -2, 3, -4]);

    await runner.close();
  });

  it('throws on initialize when the native binding is unavailable', async () => {
    vi.spyOn(warmup, '_getLocalInferenceModule').mockReturnValue(undefined);
    const runner = new EotRunner();
    await expect(runner.initialize()).rejects.toThrow(/native binding unavailable/);
  });
});
