// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type * as genai from '@google/genai';
import { describe, expect, it, vi } from 'vitest';
import { RealtimeModel } from './realtime_api.js';

type LiveCallbacks = {
  onopen: () => void;
  onmessage: (message: unknown) => void;
  onerror: (error: unknown) => void;
  onclose: (event: { code: number; reason: string }) => void;
};

const { connects } = vi.hoisted(() => ({
  connects: [] as Array<{ callbacks: LiveCallbacks }>,
}));

vi.mock('@google/genai', async (importOriginal) => {
  const actual = await importOriginal<typeof genai>();
  return {
    ...actual,
    GoogleGenAI: class {
      live = {
        connect: async ({ callbacks }: { callbacks: LiveCallbacks }) => {
          connects.push({ callbacks });
          callbacks.onopen();
          return {
            sendClientContent: () => {},
            sendRealtimeInput: () => {},
            sendToolResponse: () => {},
            close: () => {},
          };
        },
      };
    },
  };
});

/**
 * An abnormal WebSocket close is the same failure as `onerror`'s network-level
 * errors: without a restart the main task stays parked on
 * `sessionShouldClose.wait()` with a dead socket, and the session never
 * recovers.
 */
describe('RealtimeSession on abnormal WebSocket close', () => {
  it('restarts the session and emits the error as recoverable', async () => {
    connects.length = 0;
    const session = new RealtimeModel({
      model: 'gemini-2.0-flash-live-001',
      apiKey: 'test-key',
    }).session();
    const errors: Array<{ error: Error; recoverable: boolean }> = [];
    session.on('error', (ev) => errors.push(ev));

    await vi.waitFor(() => expect(connects).toHaveLength(1));
    connects[0]!.callbacks.onclose({ code: 1006, reason: '' });

    await vi.waitFor(() => expect(connects).toHaveLength(2));
    expect(errors).toHaveLength(1);
    expect(errors[0]!.recoverable).toBe(true);
    expect(errors[0]!.error.message).toContain('WebSocket closed with code 1006');

    await session.close();
  });

  it('does not restart or emit on a normal close', async () => {
    connects.length = 0;
    const session = new RealtimeModel({
      model: 'gemini-2.0-flash-live-001',
      apiKey: 'test-key',
    }).session();
    const errors: Array<{ error: Error; recoverable: boolean }> = [];
    session.on('error', (ev) => errors.push(ev));

    await vi.waitFor(() => expect(connects).toHaveLength(1));
    connects[0]!.callbacks.onclose({ code: 1000, reason: '' });

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(connects).toHaveLength(1);
    expect(errors).toHaveLength(0);

    await session.close();
  });
});
