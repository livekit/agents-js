// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type * as googleGenai from '@google/genai';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LLM } from './llm.js';

const googleMocks = vi.hoisted(() => ({
  constructorOptions: [] as unknown[],
  modelLists: [] as Array<{ mock: { calls: unknown[][] } }>,
}));

vi.mock('@google/genai', async (importOriginal) => {
  const actual = await importOriginal<typeof googleGenai>();
  return {
    ...actual,
    GoogleGenAI: class {
      models: { list: ReturnType<typeof vi.fn> };

      constructor(options: unknown) {
        const list = vi.fn(async () => {});
        this.models = { list };
        googleMocks.constructorOptions.push(options);
        googleMocks.modelLists.push(list);
      }
    },
  };
});

describe('Google LLM prewarm', () => {
  beforeEach(() => {
    googleMocks.constructorOptions.length = 0;
    googleMocks.modelLists.length = 0;
  });

  it('lists one model with the prewarm cancellation signal', async () => {
    const llm = new LLM({ model: 'gemini-2.5-flash', apiKey: 'test-key' });

    llm.prewarm();
    await new Promise<void>((resolve) => setImmediate(resolve));

    const modelsList = googleMocks.modelLists[0]!;
    expect(modelsList.mock.calls).toEqual([
      [{ config: { pageSize: 1, abortSignal: expect.any(AbortSignal) } }],
    ]);
    const signal = (
      modelsList.mock.calls[0]![0] as {
        config: { abortSignal: AbortSignal };
      }
    ).config.abortSignal;
    expect(signal.aborted).toBe(false);

    await llm.aclose();
    expect(signal.aborted).toBe(true);
  });

  it('uses the same models request on the Vertex auth warmup path', async () => {
    const llm = new LLM({
      model: 'gemini-2.5-flash',
      vertexai: true,
      project: 'test-project',
      location: 'test-location',
    });

    llm.prewarm();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(googleMocks.constructorOptions).toEqual([
      {
        vertexai: true,
        project: 'test-project',
        location: 'test-location',
      },
    ]);
    expect(googleMocks.modelLists[0]!.mock.calls).toEqual([
      [{ config: { pageSize: 1, abortSignal: expect.any(AbortSignal) } }],
    ]);

    await llm.aclose();
  });
});
