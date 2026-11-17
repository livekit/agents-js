// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { ReadableStream } from 'node:stream/web';
import { beforeAll, expect, it, vi } from 'vitest';
import { initializeLogger } from '../log.js';
import { Future } from '../utils.js';
import { performTextForwarding } from './generation.js';
import { TextOutput, type TimedString, createTimedString } from './io.js';

beforeAll(() => initializeLogger({ pretty: false, level: 'warn' }));
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

class Output extends TextOutput {
  captured: (string | TimedString)[] = [];
  override async captureText(text: string | TimedString) {
    this.captured.push(text);
  }
  override flush = vi.fn();
}

it('joins asynchronous source cancellation before completing the text task', async () => {
  const released = new Future<void>();
  const cancel = vi.fn(() => released.await);
  const source = new ReadableStream<string>({ cancel });
  const controller = new AbortController();
  const output = new Output();
  const [task, text] = performTextForwarding(source, controller, output);
  controller.abort();
  await tick();
  expect(cancel).toHaveBeenCalledOnce();
  expect(task.done).toBe(false);
  released.resolve();
  await task.result;
  expect(task.done).toBe(true);
  expect(source.locked).toBe(false);
  expect(output.captured).toEqual([]);
  expect(text.text).toBe('');
  expect(output.flush).toHaveBeenCalledOnce();
});

it('does not forward a resolved read after cancellation', async () => {
  let input!: ReadableStreamDefaultController<string>;
  const cancel = vi.fn();
  const source = new ReadableStream<string>({
    start(c) {
      input = c;
    },
    cancel,
  });
  const controller = new AbortController();
  const output = new Output();
  const [task, text] = performTextForwarding(source, controller, output);
  input.enqueue('late');
  controller.abort();
  await task.result;
  expect(output.captured).toEqual([]);
  expect(text.text).toBe('');
  expect(cancel).toHaveBeenCalledOnce();
  expect(source.locked).toBe(false);
});

it('cancels an unread source when forwarding starts after abort', async () => {
  const cancel = vi.fn();
  const source = new ReadableStream<string>({
    start(c) {
      c.enqueue('late');
    },
    cancel,
  });
  const controller = new AbortController();
  controller.abort();
  const output = new Output();
  const [task] = performTextForwarding(source, controller, output);
  await task.result;
  expect(cancel).toHaveBeenCalledOnce();
  expect(output.captured).toEqual([]);
  expect(source.locked).toBe(false);
});

it('preserves normal text and timed transcription chunks', async () => {
  const timed = createTimedString({ text: 'second', startTime: 0, endTime: 1 });
  const source = new ReadableStream<string | TimedString>({
    start(c) {
      c.enqueue('first');
      c.enqueue(timed);
      c.close();
    },
  });
  const output = new Output();
  const [task, text] = performTextForwarding(source, new AbortController(), output);
  await task.result;
  expect(output.captured).toEqual(['first', timed]);
  expect(text.text).toBe('firstsecond');
  expect(text.firstTextFut.done).toBe(true);
  expect(output.flush).toHaveBeenCalledOnce();
  expect(source.locked).toBe(false);
});

it.each(['read', 'capture', 'flush'] as const)(
  'propagates %s errors and releases the source',
  async (stage) => {
    const error = new Error(`${stage} failed`);
    const cancel = vi.fn();
    const source = new ReadableStream<string>({
      start(c) {
        if (stage === 'read') c.error(error);
        else c.enqueue('first');
      },
      cancel,
    });
    const output = new Output();
    const controller = new AbortController();
    if (stage === 'capture')
      output.captureText = async () => {
        throw error;
      };
    if (stage === 'flush') {
      output.flush.mockImplementation(() => {
        throw error;
      });
      controller.abort();
    }
    const [task] = performTextForwarding(source, controller, output);
    await expect(task.result).rejects.toBe(error);
    expect(source.locked).toBe(false);
    expect(cancel).toHaveBeenCalledTimes(stage === 'read' ? 0 : 1);
  },
);

it('consumes cancellation rejection and still releases the reader', async () => {
  const source = new ReadableStream<string>({
    cancel: async () => {
      throw new Error('cancel failed');
    },
  });
  const controller = new AbortController();
  const output = new Output();
  const [task] = performTextForwarding(source, controller, output);
  controller.abort();
  await task.result;
  expect(task.done).toBe(true);
  expect(source.locked).toBe(false);
  expect(output.flush).toHaveBeenCalledOnce();
});
