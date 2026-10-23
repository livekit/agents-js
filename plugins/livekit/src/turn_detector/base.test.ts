// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { IdleTimeoutError, llm } from '@livekit/agents';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EOUModel } from './base.js';

class TestModel extends EOUModel {
  inferenceMethod() {
    return 'test';
  }
}

describe('EOUModel', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('times out predictEndOfTurn after 3 seconds by default', async () => {
    vi.useFakeTimers();
    const model = new TestModel({
      modelType: 'en',
      executor: { doInference: () => new Promise(() => {}) },
      loadLanguages: false,
    });

    const result = expect(model.predictEndOfTurn(llm.ChatContext.empty())).rejects.toThrow(
      IdleTimeoutError,
    );
    await vi.advanceTimersByTimeAsync(3000);
    await result;
  });
});
