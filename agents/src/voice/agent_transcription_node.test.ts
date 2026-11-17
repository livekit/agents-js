// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { ReadableStream } from 'node:stream/web';
import { describe, expect, it, vi } from 'vitest';
import { Future } from '../utils.js';
import { Agent, AgentTask } from './agent.js';
import type { AgentHooks } from './agent_v2.js';

type Hook = NonNullable<AgentHooks<unknown>['transcriptionNode']>;
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function source() {
  let controller!: ReadableStreamDefaultController<string>;
  const cancel = vi.fn();
  const stream = new ReadableStream<string>({
    start(c) {
      controller = c;
    },
    cancel,
  });
  return { stream, controller, cancel };
}
async function collect<T>(stream: ReadableStream<T>) {
  const values: T[] = [];
  for await (const value of stream) values.push(value);
  return values;
}

describe.each(['Agent', 'AgentTask'] as const)('%s public transcription adapter', (kind) => {
  const create = (transcriptionNode: Hook) =>
    kind === 'Agent'
      ? Agent.create({ instructions: 'test', transcriptionNode })
      : AgentTask.create<void>({ instructions: 'test', transcriptionNode });

  it('retains deferred input through normal transformation and EOF', async () => {
    const input = source();
    const release = new Future<void>();
    let exited = false;
    const agent = create(async function* (_ctx, text) {
      try {
        await release.await;
        for await (const chunk of text) yield String(chunk).toUpperCase();
      } finally {
        exited = true;
      }
    });
    const output = await agent.transcriptionNode(input.stream, {});
    expect(input.stream.locked).toBe(false);
    input.controller.enqueue('hello');
    input.controller.close();
    release.resolve();
    await expect(collect(output!)).resolves.toEqual(['HELLO']);
    expect(exited).toBe(true);
    expect(input.stream.locked).toBe(false);
    expect(input.cancel).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'joins cancellation of a pending input read after first chunk: %s',
    async (first) => {
      const input = source();
      const entered = new Future<void>();
      let exited = false;
      const agent = create(async function* (_ctx, text) {
        try {
          entered.resolve();
          for await (const chunk of text) yield chunk;
        } finally {
          exited = true;
        }
      });
      if (first) input.controller.enqueue('hello');
      const output = (await agent.transcriptionNode(input.stream, {}))!;
      const reader = output.getReader();
      let cancelling: Promise<void> | undefined;
      try {
        await entered.await;
        if (first) await expect(reader.read()).resolves.toMatchObject({ value: 'hello' });
        await tick();
        expect(input.stream.locked).toBe(true);
        cancelling = reader.cancel();
        await cancelling;
        expect(exited).toBe(true);
        expect(input.stream.locked).toBe(false);
        // The activity owns the source and its tee sibling. The adapter owns only its iterator.
        await input.stream.cancel();
        expect(input.cancel).toHaveBeenCalledOnce();
      } finally {
        try {
          input.controller.close();
        } catch {
          /* already cancelled */
        }
        await cancelling;
        reader.releaseLock();
      }
    },
  );

  it('cancels before deferred reader acquisition without consuming late input', async () => {
    const input = source();
    const release = new Future<void>();
    const seen: unknown[] = [];
    let exited = false;
    const agent = create(async function* (_ctx, text) {
      try {
        await release.await;
        for await (const chunk of text) {
          seen.push(chunk);
          yield chunk;
        }
      } finally {
        exited = true;
      }
    });
    const output = (await agent.transcriptionNode(input.stream, {}))!;
    const cancelling = output.cancel();
    input.controller.enqueue('late');
    input.controller.close();
    release.resolve();
    await cancelling;
    expect(exited).toBe(true);
    expect(seen).toEqual([]);
    expect(input.stream.locked).toBe(false);
  });

  it.each(['null', 'reject', 'throw'] as const)(
    'releases a pending SDK input read when the hook returns %s',
    async (ending) => {
      const input = source();
      const failure = new Error('hook failed');
      let reading: Promise<IteratorResult<unknown>> | undefined;
      const agent = create((_ctx, text) => {
        reading = text[Symbol.asyncIterator]().next();
        if (ending === 'throw') throw failure;
        return ending === 'null' ? null : Promise.reject(failure);
      });
      try {
        const result = agent.transcriptionNode(input.stream, {});
        if (ending === 'null') await expect(result).resolves.toBeNull();
        else await expect(result).rejects.toBe(failure);
        expect(input.stream.locked).toBe(false);
        await expect(reading).resolves.toMatchObject({ done: true });
      } finally {
        input.controller.close();
      }
    },
  );

  it('releases an input iterator left suspended by early output completion', async () => {
    const input = source();
    input.controller.enqueue('hello');
    const agent = create(async function* (_ctx, text) {
      const iterator = text[Symbol.asyncIterator]();
      yield (await iterator.next()).value!;
    });
    await expect(collect((await agent.transcriptionNode(input.stream, {}))!)).resolves.toEqual([
      'hello',
    ]);
    expect(input.stream.locked).toBe(false);
    await input.stream.cancel();
  });

  it.each(['source', 'output'] as const)(
    'preserves the original %s error and releases input',
    async (where) => {
      const input = source();
      const failure = new Error(where + ' failed');
      let exited = false;
      const agent = create(async function* (_ctx, text) {
        try {
          for await (const chunk of text) {
            if (where === 'output') throw failure;
            yield chunk;
          }
        } finally {
          exited = true;
        }
      });
      const output = (await agent.transcriptionNode(input.stream, {}))!;
      if (where === 'source') input.controller.error(failure);
      else input.controller.enqueue('hello');
      await expect(collect(output)).rejects.toBe(failure);
      expect(exited).toBe(true);
      expect(input.stream.locked).toBe(false);
      if (where === 'output') await input.stream.cancel();
    },
  );

  it('does not take ownership of a caller AsyncIterable when the hook returns null', async () => {
    const returned = vi.fn();
    const input = {
      [Symbol.asyncIterator]: () => ({
        next: async () => ({ done: true as const, value: undefined }),
        return: returned,
      }),
    };
    const agent = create((_ctx, text) => {
      expect(text).toBe(input);
      return null;
    });
    await expect(agent.transcriptionNode(input, {})).resolves.toBeNull();
    expect(returned).not.toHaveBeenCalled();
  });

  it('joins forwarding even when the returned iterator rejects cancellation', async () => {
    const input = source();
    const failure = new Error('iterator return failed');
    const entered = new Future<void>();
    let nextFinished = false;
    const agent = create((_ctx, text) => ({
      [Symbol.asyncIterator]() {
        const reader = text[Symbol.asyncIterator]();
        return {
          async next() {
            entered.resolve();
            const result = await reader.next();
            await tick();
            nextFinished = true;
            return result;
          },
          async return() {
            throw failure;
          },
        };
      },
    }));
    const output = (await agent.transcriptionNode(input.stream, {}))!;
    await entered.await;
    await expect(output.cancel()).rejects.toBe(failure);
    expect(nextFinished).toBe(true);
    expect(input.stream.locked).toBe(false);
    await input.stream.cancel();
  });

  it('releases input if acquiring the output iterator throws', async () => {
    const input = source();
    const failure = new Error('iterator acquisition failed');
    let reading: Promise<IteratorResult<unknown>> | undefined;
    const agent = create((_ctx, text) => {
      reading = text[Symbol.asyncIterator]().next();
      return {
        [Symbol.asyncIterator]() {
          throw failure;
        },
      };
    });
    await expect(agent.transcriptionNode(input.stream, {})).rejects.toBe(failure);
    await expect(reading).resolves.toMatchObject({ done: true });
    expect(input.stream.locked).toBe(false);
    await input.stream.cancel();
  });
});
