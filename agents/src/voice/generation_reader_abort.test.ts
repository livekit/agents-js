// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioFrame } from '@livekit/rtc-node';
import { ReadableStream } from 'node:stream/web';
import { describe, expect, it, vi } from 'vitest';
import type { Task } from '../utils.js';
import { performTTSInference, performTextForwarding } from './generation.js';

async function checkPendingRead<T>(
  createTask: (source: ReadableStream<T>, abort: AbortController) => Task<void>,
  isAbortedBeforeStart: boolean,
): Promise<void> {
  const abort = new AbortController();
  let didCancel = false;
  let didFinish = false;
  let closeSource: () => void = () => {};
  const source = new ReadableStream<T>({
    start(controller) {
      closeSource = () => controller.close();
    },
    cancel() {
      didCancel = true;
    },
  });
  const addListener = vi.spyOn(abort.signal, 'addEventListener');
  const removeListener = vi.spyOn(abort.signal, 'removeEventListener');
  if (isAbortedBeforeStart) abort.abort();
  const task = createTask(source, abort);
  const done = task.result.then(() => {
    didFinish = true;
  });
  try {
    if (!isAbortedBeforeStart) {
      await vi.waitFor(() => expect(source.locked).toBe(true));
      abort.abort();
    }
    await vi.waitFor(() => expect(didFinish).toBe(true), { timeout: 500 });
    expect(didCancel).toBe(true);
    const callback = addListener.mock.calls.find(([name]) => name === 'abort')?.[1];
    expect(callback).toBeDefined();
    expect(removeListener).toHaveBeenCalledWith('abort', callback);
  } finally {
    if (!didCancel) closeSource();
    await done;
    addListener.mockRestore();
    removeListener.mockRestore();
  }
}

describe('pending generation reader cancellation', () => {
  it.each([false, true])('cancels text reads (already aborted: %s)', async (isAborted) => {
    await checkPendingRead<string>(
      (source, abort) => performTextForwarding(source, abort, null)[0],
      isAborted,
    );
  });

  it.each([false, true])('cancels TTS reads (already aborted: %s)', async (isAborted) => {
    await checkPendingRead<AudioFrame>((source, abort) => {
      const text = new ReadableStream<string>({
        start(controller) {
          controller.close();
        },
      });
      return performTTSInference(async () => source, text, {}, abort)[0];
    }, isAborted);
  });

  it('discards text delivered immediately before the abort', async () => {
    const abort = new AbortController();
    let enqueue: (text: string) => void = () => {};
    const source = new ReadableStream<string>({
      start(controller) {
        enqueue = (text) => controller.enqueue(text);
      },
    });
    const [task, output] = performTextForwarding(source, abort, null);
    await vi.waitFor(() => expect(source.locked).toBe(true));
    enqueue('Do not speak this.');
    abort.abort();
    await task.result;
    expect(output.text).toBe('');
  });

  it('discards audio delivered immediately before the abort', async () => {
    const abort = new AbortController();
    let enqueue: (frame: AudioFrame) => void = () => {};
    const source = new ReadableStream<AudioFrame>({
      start(controller) {
        enqueue = (frame) => controller.enqueue(frame);
      },
    });
    const text = new ReadableStream<string>({
      start(controller) {
        controller.close();
      },
    });
    const [task, output] = performTTSInference(async () => source, text, {}, abort);
    await vi.waitFor(() => expect(source.locked).toBe(true));
    enqueue(new AudioFrame(new Int16Array(480), 24000, 1, 480));
    abort.abort();
    await task.result;
    const reader = output.audioStream.getReader();
    try {
      expect(await reader.read()).toEqual({ done: true, value: undefined });
    } finally {
      reader.releaseLock();
    }
  });
});
