// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as warmup from '../inference/_warmup.js';
import { _preloadLocalInference } from './_preload.js';

describe('local inference preload', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it.each(['0', 'false', 'no', 'off', 'FALSE', ' off '])('can be disabled with %j', (value) => {
    vi.stubEnv(warmup.ENV_PRELOAD_LOCAL_INFERENCE, value);
    const load = vi.spyOn(warmup, '_getLocalInferenceModule');

    expect(_preloadLocalInference()).toBe(false);
    expect(load).not.toHaveBeenCalled();
  });

  it.each(['1', 'true', 'yes', 'on', ''])('preloads for explicit value %j', (value) => {
    vi.stubEnv(warmup.ENV_PRELOAD_LOCAL_INFERENCE, value);
    const load = vi.spyOn(warmup, '_getLocalInferenceModule').mockReturnValue(undefined);

    expect(_preloadLocalInference()).toBe(true);
    expect(load).toHaveBeenCalledOnce();
  });

  it('preloads by default', () => {
    vi.stubEnv(warmup.ENV_PRELOAD_LOCAL_INFERENCE, undefined);
    const load = vi.spyOn(warmup, '_getLocalInferenceModule').mockReturnValue(undefined);

    expect(_preloadLocalInference()).toBe(true);
    expect(load).toHaveBeenCalledOnce();
  });
});
