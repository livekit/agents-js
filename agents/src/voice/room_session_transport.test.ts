// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AgentSession as pb } from '@livekit/protocol';
import { ByteStreamReader, type Room } from '@livekit/rtc-node';
import { LocalParticipant } from '@livekit/rtc-node';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { initializeLogger } from '../log.js';
import { type AsyncIterableQueue, Future, Task } from '../utils.js';
import { RoomSessionTransport } from './remote_session.js';
import type { RoomIO } from './room_io/room_io.js';
import { createRoomTransport, messageEvent, pingMessage } from './testing/remote_session.js';

beforeAll(() => initializeLogger({ pretty: false, level: 'warn' }));
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});

describe('SessionTransport failures surface to the caller', () => {
  it('room transport rejects when the room is not connected', async () => {
    const room = { isConnected: false, registerByteStreamHandler: () => {} };
    const transport = new RoomSessionTransport(
      room as unknown as Room,
      { linkedParticipant: undefined } as unknown as RoomIO,
    );
    await expect(transport.sendMessage(pingMessage('r1'))).rejects.toThrow(
      /room session transport is closed/,
    );
  });
});

describe('session response delivery', () => {
  it('raises instead of dropping room transport messages', async () => {
    await expect(
      createRoomTransport({ streamError: new Error('stream refused') }).transport.sendMessage(
        new pb.AgentSessionMessage(),
      ),
    ).rejects.toThrow('failed to send binary stream message');
    await expect(
      createRoomTransport({ connected: false }).transport.sendMessage(new pb.AgentSessionMessage()),
    ).rejects.toThrow('closed');
    await expect(
      createRoomTransport().transport.sendMessage(new pb.AgentSessionMessage()),
    ).resolves.toBeUndefined();
  });

  it('serializes concurrent room transport sends', async () => {
    let inFlight = 0;
    let overlapping = false;
    const { room, transport } = createRoomTransport();
    cleanup.push(() => transport.close());
    vi.mocked(room.localParticipant!.streamBytes).mockImplementation(async () => {
      inFlight += 1;
      if (inFlight > 1) overlapping = true;
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight -= 1;
      return { write: vi.fn(async () => {}), close: vi.fn(async () => {}) } as never;
    });

    await Promise.all(
      Array.from({ length: 8 }, () => transport.sendMessage(new pb.AgentSessionMessage())),
    );
    expect(overlapping).toBe(false);
  });

  it('reads inbound room messages sequentially and keeps them ordered', async () => {
    type StreamHandler = (reader: ByteStreamReader, info: { identity: string }) => void;
    let handler: StreamHandler | undefined;
    const { room, transport } = createRoomTransport();
    cleanup.push(() => transport.close());
    vi.mocked(room.registerByteStreamHandler).mockImplementation((_topic, callback) => {
      handler = callback as StreamHandler;
    });
    await transport.start();

    let active = 0;
    let overlapping = false;
    for (let i = 0; i < 10; i += 1) {
      const data = new pb.AgentSessionMessage({
        message: { case: 'event', value: messageEvent(String(i)) },
      }).toBinary();
      handler?.(
        {
          readAll: async () => {
            active += 1;
            if (active > 1) overlapping = true;
            await new Promise((resolve) => setTimeout(resolve, 1));
            active -= 1;
            return [data.subarray(0, 1), data.subarray(1)];
          },
        } as unknown as ByteStreamReader,
        { identity: 'remote' },
      );
    }

    const iterator = transport[Symbol.asyncIterator]();
    const received: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      const msg = (await iterator.next()).value;
      const event = msg.message.value as pb.AgentSessionEvent;
      received.push((event.event.value as pb.AgentSessionEvent_UserInputTranscribed).transcript);
    }
    expect(overlapping).toBe(false);
    expect(received).toEqual(Array.from({ length: 10 }, (_, i) => String(i)));
    await transport.close();
  });
});

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

it.each(['open', 'write', 'close'] as const)(
  'releases a native RTC writer after an aborted %s settles',
  async (phase) => {
    const previousFfi = globalThis._ffiClientInstance;
    const entered = new Future<void>();
    const release = new Future<void>();
    const operations: string[] = [];
    const participant = {
      ffi_handle: { handle: 100n },
      identity: 'test',
      disconnectSignal: new AbortController().signal,
      openStreamWriters: new Set<bigint>(),
      byteStreamWriterWrite: async () => {
        operations.push('write');
        if (phase === 'write') {
          entered.resolve();
          await release.await;
        }
      },
      byteStreamWriterClose: async () => {
        operations.push('close');
        if (phase === 'close') {
          entered.resolve();
          await release.await;
        }
      },
      streamBytes: LocalParticipant.prototype.streamBytes,
    };
    globalThis._ffiClientInstance = {
      request: () => ({ asyncId: 1n }),
      waitFor: async () => {
        if (phase === 'open') {
          entered.resolve();
          await release.await;
        }
        operations.push('open');
        return {
          result: {
            case: 'writer',
            value: {
              handle: { id: 200n },
              info: {
                streamId: 'test',
                name: 'test',
                mimeType: 'application/octet-stream',
                topic: 'lk.agent.session',
                timestamp: 0n,
                attributes: {},
              },
            },
          },
        };
      },
    } as never;
    const transport = new RoomSessionTransport(
      { isConnected: true, localParticipant: participant } as unknown as Room,
      { linkedParticipant: undefined } as never,
    );
    try {
      const sending = transport.sendMessage(new pb.AgentSessionMessage()).catch((e) => e);
      await entered.await;
      const queued = transport.sendMessage(new pb.AgentSessionMessage()).catch((e) => e);
      await transport.close();
      expect(await sending).toBeInstanceOf(Error);
      expect(await queued).toBeInstanceOf(Error);
      release.resolve();
      await tick();
      expect(participant.openStreamWriters.size).toBe(0);
      expect(operations).toEqual(phase === 'open' ? ['open', 'close'] : ['open', 'write', 'close']);
    } finally {
      release.resolve();
      await transport.close();
      await tick();
      globalThis._ffiClientInstance = previousFfi;
    }
  },
);

it('stops all Room sends when an active sender is aborted', async () => {
  const f = createRoomTransport();
  cleanup.push(() => f.transport.close());
  const gate = new Future<void>();
  const entered = new Future<void>();
  f.room.localParticipant.streamBytes.mockImplementation(async () => ({
    write: async () => {
      entered.resolve();
      await gate.await;
    },
    close: async () => {},
  }));
  const controller = new AbortController();
  const first = f.transport
    .sendMessage(new pb.AgentSessionMessage(), controller.signal)
    .catch((error) => error);
  await entered.await;
  const queued = f.transport.sendMessage(new pb.AgentSessionMessage()).catch((error) => error);
  controller.abort();
  expect(await first).toBeInstanceOf(Error);
  expect(await queued).toBeInstanceOf(Error);
  gate.resolve();
  await tick();
  expect(f.room.localParticipant.streamBytes).toHaveBeenCalledTimes(1);
});

it.each(['open', 'write', 'close'] as const)(
  'consumes a late Room %s failure and releases acquired writers',
  async (stage) => {
    const f = createRoomTransport();
    cleanup.push(() => f.transport.close());
    const entered = new Future<void>();
    const release = new Future<void>();
    const fail = async () => {
      entered.resolve();
      await release.await;
      throw new Error(`${stage} failed after close`);
    };
    const writer = {
      write: vi.fn(stage === 'write' ? fail : async () => {}),
      close: vi.fn(stage === 'close' ? fail : async () => {}),
    };
    f.room.localParticipant.streamBytes.mockImplementation(async () => {
      if (stage === 'open') await fail();
      return writer;
    });
    const sending = f.transport.sendMessage(new pb.AgentSessionMessage()).catch((e) => e);
    await entered.await;
    await f.transport.close();
    expect(await sending).toBeInstanceOf(Error);
    release.resolve();
    await tick();
    expect(writer.close).toHaveBeenCalledTimes(stage === 'open' ? 0 : 1);
    expect(f.room.localParticipant.streamBytes).toHaveBeenCalledOnce();
  },
);

it('closes active and queued RTC readers and joins the single read task', async () => {
  const f = createRoomTransport();
  cleanup.push(() => f.transport.close());
  await f.transport.start();
  const cancelled = [vi.fn(), vi.fn()];
  const readers = cancelled.map(
    (cancel) =>
      new ByteStreamReader(
        {
          id: 'test',
          mimeType: 'application/octet-stream',
          topic: 'test',
          timestamp: 0,
          attributes: {},
          name: 'test',
        },
        new ReadableStream({ cancel }),
      ),
  );
  const task = (f.transport as unknown as { readTask: Task<void> }).readTask;
  const create = vi.spyOn(Task, 'from');
  readers.forEach((reader) => f.raw(reader));
  await tick();
  expect(create).not.toHaveBeenCalled();
  await f.transport.close();
  expect(task.done).toBe(true);
  cancelled.forEach((cancel) => expect(cancel).toHaveBeenCalledTimes(1));
});

it('detaches Room intake before cleanup and closes readers from callbacks already in flight', async () => {
  const f = createRoomTransport();
  const release = new Future<void>();
  const entered = new Future<void>();
  const firstCancel = vi.fn(() => {
    entered.resolve();
    return release.await;
  });
  const lateCancel = vi.fn();
  const readers = [firstCancel, lateCancel].map(
    (cancel) =>
      new ByteStreamReader(
        {
          id: 'test',
          mimeType: 'application/octet-stream',
          topic: 'lk.agent.session',
          timestamp: 0,
          attributes: {},
          name: 'test',
        },
        new ReadableStream({ cancel }),
      ),
  );
  let closing: Promise<void> | undefined;
  try {
    await f.transport.start();
    f.raw(readers[0]!);
    closing = f.transport.close();
    await entered.await;
    expect.soft(f.room.unregisterByteStreamHandler).toHaveBeenCalledOnce();
    // The fixture retains the callback to model delivery already in flight.
    f.raw(readers[1]!);
    release.resolve();
    await closing;
    expect(firstCancel).toHaveBeenCalledOnce();
    expect(lateCancel).toHaveBeenCalledOnce();
  } finally {
    release.resolve();
    await closing;
    await Promise.all(readers.map((reader) => reader.close()));
    await f.transport.close();
  }
});

it('closes a dequeued reader when shutdown wins before reading starts', async () => {
  const f = createRoomTransport();
  const queue = (
    f.transport as unknown as {
      incomingReaders: AsyncIterableQueue<ByteStreamReader>;
    }
  ).incomingReaders;
  const next = queue.next.bind(queue);
  let closing: Promise<void> | undefined;
  vi.spyOn(queue, 'next').mockImplementation(async (options) => {
    const item = await next(options);
    if (!item.done) closing = f.transport.close();
    return item;
  });
  const readAll = vi.fn(async () => []);
  const close = vi.fn(async () => {});
  try {
    await f.transport.start();
    f.raw({ readAll, close } as unknown as ByteStreamReader);
    await tick();
    await closing;
    expect(readAll).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  } finally {
    await f.transport.close();
  }
});
