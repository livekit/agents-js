// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioFrame } from '@livekit/rtc-node';
import { ReadableStream } from 'node:stream/web';
import { describe, expect, it, vi } from 'vitest';
import { Future, type Task } from '../utils.js';
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
  it.each(['finish', 'abort', 'error'] as const)(
    'does not cancel a released TTS text reader on %s',
    async (outcome) => {
      const abort = new AbortController();
      const finish = new Future<void>();
      const failure = new Error('synthesis failed');
      const text = new ReadableStream<string>({
        start(controller) {
          controller.enqueue('Hello');
          controller.close();
        },
      });
      const getReader = vi.spyOn(text, 'getReader');
      const [task, output] = performTTSInference(
        async (input) => {
          for await (const _chunk of input) {
            // Consume all text before synthesis completes.
          }
          await finish.await;
          if (outcome === 'error') throw failure;
          return null;
        },
        text,
        {},
        abort,
        undefined,
        undefined,
        undefined,
        undefined,
        { cancelOnFinish: true, onError: vi.fn() },
      );
      const reader = getReader.mock.results[0]!.value as ReadableStreamDefaultReader<string>;
      const cancel = vi.spyOn(reader, 'cancel');
      try {
        await vi.waitFor(() => expect(text.locked).toBe(false));
        if (outcome === 'abort') abort.abort();
        finish.resolve();
        if (outcome === 'error') await expect(task.result).rejects.toBe(failure);
        else await task.result;
        await expect(
          Promise.all(cancel.mock.results.map((result) => result.value)),
        ).resolves.toEqual([]);
        expect(output.error).toBe(outcome === 'error' ? failure : null);
      } finally {
        finish.resolve();
        abort.abort();
        await task.result.catch(() => {});
        cancel.mockRestore();
        getReader.mockRestore();
      }
    },
  );

  it.each([false, true])('cancels text reads (already aborted: %s)', async (isAborted) => {
    await checkPendingRead<string>(
      (source, abort) => performTextForwarding(source, abort, null)[0],
      isAborted,
    );
  });

  it('joins pending TTS text cancellation before releasing the reader', async () => {
    const cancelled = new Future<void>();
    const release = new Future<void>();
    const text = new ReadableStream<string>({
      cancel() {
        cancelled.resolve();
        return release.await;
      },
    });
    const abort = new AbortController();
    const [task] = performTTSInference(async () => null, text, {}, abort);
    try {
      abort.abort();
      await cancelled.await;
      expect(task.done).toBe(false);
      expect(text.locked).toBe(true);
      release.resolve();
      await task.result;
      expect(text.locked).toBe(false);
    } finally {
      release.resolve();
      await task.result;
    }
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
