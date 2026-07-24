// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as jobModule from '../../job.js';
import { RealtimeModel } from '../../llm/index.js';
import { IdentityTransform } from '../../stream/identity_transform.js';
import { DEFAULT_API_CONNECT_OPTIONS } from '../../types.js';
import { AgentSessionEventTypes, CloseReason, createCloseEvent } from '../events.js';
import { RoomIO } from './room_io.js';

type RoomIOArgs = ConstructorParameters<typeof RoomIO>[0];

/**
 * Regression tests proving WritableStream.close() rejects when the writer is
 * already closed or errored — the exact scenario RoomIO.close() guards against
 * with a try/catch.
 *
 * RoomIO holds a WritableStreamDefaultWriter for user transcript forwarding.
 * During teardown, the writer may already be closed or errored (e.g. a
 * concurrent write failed during speech interruption). Without the guard,
 * close() throws ERR_INVALID_STATE and crashes teardown.
 */
describe('RoomIO WritableStream close guard', () => {
  it('should reject when closing an already-closed writer', async () => {
    const transform = new IdentityTransform<string>();
    const writer = transform.writable.getWriter();

    await writer.close();

    // Proves the bug: second close() rejects — RoomIO.close() must guard this.
    await expect(writer.close()).rejects.toThrow();
  });

  it('should reject when closing a writer on an errored stream', async () => {
    const transform = new IdentityTransform<string>();
    const writer = transform.writable.getWriter();

    // Force the stream into an errored state
    await writer.abort(new Error('simulated write failure'));

    // Proves the bug: close() on errored writer rejects — RoomIO.close() must guard this.
    await expect(writer.close()).rejects.toThrow();
  });
});

function createFakeRoom() {
  const emitter = new EventEmitter();

  return {
    name: 'test-room',
    isConnected: false,
    remoteParticipants: new Map(),
    localParticipant: { identity: 'agent' },
    on: vi.fn((event: string | symbol, listener: (...args: unknown[]) => void) => {
      emitter.on(event, listener);
      return emitter;
    }),
    off: vi.fn((event: string | symbol, listener: (...args: unknown[]) => void) => {
      emitter.off(event, listener);
      return emitter;
    }),
    registerTextStreamHandler: vi.fn(),
    unregisterTextStreamHandler: vi.fn(),
  };
}

type FakeSession = {
  input: { audio: null };
  output: { audio: null; transcription: null };
  currentAgent?: { llm?: RealtimeModel };
  llm?: RealtimeModel;
  on: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
  emit: (event: string | symbol, value: unknown) => boolean;
  _closeSoon: ReturnType<typeof vi.fn>;
};

function createFakeSession(llm?: RealtimeModel): FakeSession {
  const emitter = new EventEmitter();

  return {
    input: { audio: null },
    output: { audio: null, transcription: null },
    currentAgent: undefined,
    llm,
    on: vi.fn((event: string | symbol, listener: (...args: unknown[]) => void) => {
      emitter.on(event, listener);
      return emitter;
    }),
    off: vi.fn((event: string | symbol, listener: (...args: unknown[]) => void) => {
      emitter.off(event, listener);
      return emitter;
    }),
    emit: (event: string | symbol, value: unknown) => emitter.emit(event, value),
    _closeSoon: vi.fn(),
  };
}

class FakeRealtimeModel extends RealtimeModel {
  constructor(nativeTranscriptSync?: boolean) {
    super({
      messageTruncation: true,
      turnDetection: true,
      userTranscription: true,
      autoToolReplyGeneration: true,
      audioOutput: true,
      manualFunctionCalls: true,
      nativeTranscriptSync,
    });
  }

  get model(): string {
    return 'fake-realtime';
  }

  session(): never {
    throw new Error('not used');
  }

  async close(): Promise<void> {}
}

describe('RoomIO native transcript synchronization', () => {
  it('disables SDK synchronization when the initial realtime model synchronizes natively', async () => {
    const room = createFakeRoom();
    const session = createFakeSession(new FakeRealtimeModel(true));
    const roomIO = new RoomIO({
      // @ts-expect-error This focused test uses the minimal AgentSession surface RoomIO consumes.
      agentSession: session,
      // @ts-expect-error This focused test uses the minimal Room surface RoomIO consumes.
      room,
      inputOptions: { audioEnabled: false, textEnabled: false },
    });

    roomIO.start();

    const synchronizer = Reflect.get(roomIO, 'transcriptionSynchronizer');
    expect(synchronizer.enabled).toBe(false);
    await roomIO.close();
  });

  it.each([false, undefined])(
    'keeps SDK synchronization enabled when native synchronization is %s',
    async (nativeTranscriptSync) => {
      const room = createFakeRoom();
      const session = createFakeSession(new FakeRealtimeModel(nativeTranscriptSync));
      const roomIO = new RoomIO({
        // @ts-expect-error This focused test uses the minimal AgentSession surface RoomIO consumes.
        agentSession: session,
        // @ts-expect-error This focused test uses the minimal Room surface RoomIO consumes.
        room,
        inputOptions: { audioEnabled: false, textEnabled: false },
      });

      roomIO.start();

      const synchronizer = Reflect.get(roomIO, 'transcriptionSynchronizer');
      expect(synchronizer.enabled).toBe(true);
      await roomIO.close();
    },
  );

  it.each([
    { initial: true, handoff: false, expected: true },
    { initial: false, handoff: true, expected: false },
    { initial: true, handoff: undefined, expected: true },
  ])(
    'updates SDK synchronization after handoff from $initial to $handoff',
    async ({ initial, handoff, expected }) => {
      const room = createFakeRoom();
      const session = createFakeSession(new FakeRealtimeModel(initial));
      const roomIO = new RoomIO({
        // @ts-expect-error This focused test uses the minimal AgentSession surface RoomIO consumes.
        agentSession: session,
        // @ts-expect-error This focused test uses the minimal Room surface RoomIO consumes.
        room,
        inputOptions: { audioEnabled: false, textEnabled: false },
      });
      roomIO.start();

      session.currentAgent = { llm: new FakeRealtimeModel(handoff) };
      session.emit(AgentSessionEventTypes.ConversationItemAdded, {
        item: { type: 'agent_handoff' },
      });

      const synchronizer = Reflect.get(roomIO, 'transcriptionSynchronizer');
      expect(synchronizer.enabled).toBe(expected);
      await roomIO.close();
    },
  );
});

describe('RoomIO deleteRoomOnClose', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('does not delete the room by default when the session closes', async () => {
    const deleteRoom = vi.fn(async () => {});
    vi.spyOn(jobModule, 'getJobContext').mockReturnValue({
      deleteRoom,
    } as unknown as ReturnType<typeof jobModule.getJobContext>);
    const room = createFakeRoom();
    const session = createFakeSession();
    const roomIO = new RoomIO({
      agentSession: session as unknown as RoomIOArgs['agentSession'],
      room: room as unknown as RoomIOArgs['room'],
      inputOptions: {
        audioEnabled: false,
        textEnabled: false,
      },
      outputOptions: {
        audioEnabled: false,
        transcriptionEnabled: false,
      },
    });

    roomIO.start();
    session.emit(AgentSessionEventTypes.Close, createCloseEvent(CloseReason.USER_INITIATED, null));
    await roomIO.close();

    expect(deleteRoom).not.toHaveBeenCalled();
  });

  it('deletes the room once when deleteRoomOnClose is enabled and the session closes', async () => {
    const deleteRoom = vi.fn(async () => {});
    vi.spyOn(jobModule, 'getJobContext').mockReturnValue({
      deleteRoom,
    } as unknown as ReturnType<typeof jobModule.getJobContext>);
    const room = createFakeRoom();
    const session = createFakeSession();
    const roomIO = new RoomIO({
      agentSession: session as unknown as RoomIOArgs['agentSession'],
      room: room as unknown as RoomIOArgs['room'],
      inputOptions: {
        audioEnabled: false,
        textEnabled: false,
        deleteRoomOnClose: true,
      },
      outputOptions: {
        audioEnabled: false,
        transcriptionEnabled: false,
      },
    });

    roomIO.start();
    session.emit(AgentSessionEventTypes.Close, createCloseEvent(CloseReason.USER_INITIATED, null));
    session.emit(AgentSessionEventTypes.Close, createCloseEvent(CloseReason.USER_INITIATED, null));
    await roomIO.close();

    expect(deleteRoom).toHaveBeenCalledTimes(1);
    expect(deleteRoom).toHaveBeenCalledWith(room.name);
  });

  it('uses the job context captured at construction when close runs outside job context', async () => {
    const deleteRoom = vi.fn(async () => {});
    vi.spyOn(jobModule, 'getJobContext')
      .mockReturnValueOnce({
        deleteRoom,
      } as unknown as ReturnType<typeof jobModule.getJobContext>)
      .mockReturnValue(undefined);
    const room = createFakeRoom();
    const session = createFakeSession();
    const roomIO = new RoomIO({
      agentSession: session as unknown as RoomIOArgs['agentSession'],
      room: room as unknown as RoomIOArgs['room'],
      inputOptions: {
        audioEnabled: false,
        textEnabled: false,
        deleteRoomOnClose: true,
      },
      outputOptions: {
        audioEnabled: false,
        transcriptionEnabled: false,
      },
    });

    roomIO.start();
    session.emit(AgentSessionEventTypes.Close, createCloseEvent(CloseReason.USER_INITIATED, null));
    await roomIO.close();

    expect(deleteRoom).toHaveBeenCalledTimes(1);
    expect(deleteRoom).toHaveBeenCalledWith(room.name);
  });

  it('waits up to the API timeout for an in-flight room deletion during close', async () => {
    vi.useFakeTimers();
    const deleteRoom = vi.fn(() => new Promise<void>(() => {}));
    vi.spyOn(jobModule, 'getJobContext').mockReturnValue({
      deleteRoom,
    } as unknown as ReturnType<typeof jobModule.getJobContext>);
    const room = createFakeRoom();
    const session = createFakeSession();
    const roomIO = new RoomIO({
      agentSession: session as unknown as RoomIOArgs['agentSession'],
      room: room as unknown as RoomIOArgs['room'],
      inputOptions: {
        audioEnabled: false,
        textEnabled: false,
        deleteRoomOnClose: true,
      },
      outputOptions: {
        audioEnabled: false,
        transcriptionEnabled: false,
      },
    });

    roomIO.start();
    session.emit(AgentSessionEventTypes.Close, createCloseEvent(CloseReason.USER_INITIATED, null));

    let closed = false;
    const closePromise = roomIO.close().then(() => {
      closed = true;
    });

    await vi.advanceTimersByTimeAsync(DEFAULT_API_CONNECT_OPTIONS.timeoutMs - 1);
    expect(closed).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await closePromise;
    expect(closed).toBe(true);
  });
});
