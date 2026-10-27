// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InferenceExecutor } from '../../ipc/inference_executor.js';
import type { BaseStreamingTurnDetectorStream } from './base.js';
import { ThresholdOptions } from './languages.js';
import { LocalTransport } from './transports.js';

const binding = vi.hoisted(() => ({ missing: false }));

vi.mock('../_warmup.js', async (importOriginal) => {
  const actual = await importOriginal<{ _getLocalInferenceModule: () => unknown }>();
  return {
    ...actual,
    _getLocalInferenceModule: () => (binding.missing ? undefined : {}),
  };
});

async function predictOnce(executor: InferenceExecutor) {
  const transport = new LocalTransport({
    opts: { sampleRate: 16000, thresholds: new ThresholdOptions('turn-detector-v1-mini', {}) },
    executor,
  });
  const resolvePrediction = vi.fn();
  transport.attach({
    _resolvePrediction: resolvePrediction,
  } as unknown as BaseStreamingTurnDetectorStream);
  transport.runInference('request');
  await new Promise((r) => setImmediate(r));
  return resolvePrediction.mock.calls[0]?.[1];
}

describe('LocalTransportFailures', () => {
  afterEach(() => {
    binding.missing = false;
  });

  it('resolves a failed inference to the positive default', async () => {
    const executor: InferenceExecutor = {
      doInference: () => Promise.reject(new Error('no inference executor')),
    };

    expect(await predictOnce(executor)).toBe(1.0);
  });

  it('resolves the positive default without the binding, without calling the executor', async () => {
    binding.missing = true;
    const doInference = vi.fn();

    expect(await predictOnce({ doInference })).toBe(1.0);
    expect(doInference).not.toHaveBeenCalled();
  });
});
