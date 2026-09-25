// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  AudioFrame,
  ConnectionState,
  ParticipantKind,
  type RemoteParticipant,
  RoomEvent,
} from '@livekit/rtc-node';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as jobModule from '../../job.js';
import { RealtimeModel } from '../../llm/index.js';
import { log } from '../../log.js';
import { IdentityTransform } from '../../stream/identity_transform.js';
import { DEFAULT_API_CONNECT_OPTIONS } from '../../types.js';
import { AgentSessionEventTypes, CloseReason, createCloseEvent } from '../events.js';
import { AudioInput, AudioOutput, TextOutput } from '../io.js';
import type { TimedString } from '../io.js';
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
    emit: (event: string | symbol, ...args: unknown[]) => emitter.emit(event, ...args),
    listenerCount: (event: string | symbol) => emitter.listenerCount(event),
    registerTextStreamHandler: vi.fn(),
    unregisterTextStreamHandler: vi.fn(),
  };
}

type FakeSession = {
  input: { audio: AudioInput | null };
  output: { audio: AudioOutput | null; transcription: TextOutput | null };
  currentAgent?: { llm?: RealtimeModel };
  llm?: RealtimeModel;
  on: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
  emit: (event: string | symbol, value: unknown) => boolean;
  _closeSoon: ReturnType<typeof vi.fn>;
  _onRoomIOParticipantLinked: ReturnType<typeof vi.fn>;
  _onRoomIOParticipantUnlinked: ReturnType<typeof vi.fn>;
  resetAwayTimer: ReturnType<typeof vi.fn>;
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
    _onRoomIOParticipantLinked: vi.fn(),
    _onRoomIOParticipantUnlinked: vi.fn(),
    resetAwayTimer: vi.fn(),
  };
}

function createParticipant(identity: string): RemoteParticipant {
  return {
    identity,
    attributes: {},
    info: { kind: ParticipantKind.SIP },
  } as RemoteParticipant;
}

describe('RoomIO DTMF activity', () => {
  it.each(['linked', 'other', 'unattributed'] as const)(
    'resets away only for the linked participant when input is %s',
    async (eventSource) => {
      const room = createFakeRoom();
      const session = createFakeSession();
      const caller = createParticipant('caller');
      const other = createParticipant('other');
      const roomIO = new RoomIO({
        agentSession: session as unknown as RoomIOArgs['agentSession'],
        room: room as unknown as RoomIOArgs['room'],
        inputOptions: { audioEnabled: false, textEnabled: false },
        outputOptions: { audioEnabled: false, transcriptionEnabled: false },
      });

      roomIO.start();
      room.emit(RoomEvent.ParticipantConnected, caller);
      expect(room.listenerCount(RoomEvent.DtmfReceived)).toBe(1);

      const sender =
        eventSource === 'linked' ? caller : eventSource === 'other' ? other : undefined;
      room.emit(RoomEvent.DtmfReceived, 1, '1', sender);
      expect(session.resetAwayTimer).toHaveBeenCalledTimes(eventSource === 'linked' ? 1 : 0);

      roomIO.unsetParticipant();
      room.emit(RoomEvent.DtmfReceived, 1, '1', caller);
      expect(session.resetAwayTimer).toHaveBeenCalledTimes(eventSource === 'linked' ? 1 : 0);

      await roomIO.close();
      expect(room.listenerCount(RoomEvent.DtmfReceived)).toBe(0);
    },
  );

  it.each(['disconnect', 'unset', 'switch'] as const)(
    'pauses away detection on participant %s and restarts it on linking',
    async (reason) => {
      const room = createFakeRoom();
      const session = createFakeSession();
      const caller = createParticipant('caller');
      const replacement = createParticipant('replacement');
      room.remoteParticipants.set(caller.identity, caller);
      const roomIO = new RoomIO({
        agentSession: session as unknown as RoomIOArgs['agentSession'],
        room: room as unknown as RoomIOArgs['room'],
        participant: caller.identity,
        inputOptions: { audioEnabled: false, textEnabled: false, closeOnDisconnect: false },
        outputOptions: { audioEnabled: false, transcriptionEnabled: false },
      });
      roomIO.start();
      roomIO.setParticipant(caller.identity);
      session._onRoomIOParticipantLinked.mockClear();
      session._onRoomIOParticipantUnlinked.mockClear();

      if (reason === 'disconnect') {
        room.emit(RoomEvent.ParticipantDisconnected, caller);
      } else if (reason === 'unset') {
        roomIO.unsetParticipant();
      } else {
        roomIO.setParticipant(replacement.identity);
      }
      expect(roomIO.linkedParticipant).toBeUndefined();
      expect(session._onRoomIOParticipantUnlinked).toHaveBeenCalledOnce();

      const nextParticipant = reason === 'disconnect' ? caller : replacement;
      room.remoteParticipants.set(nextParticipant.identity, nextParticipant);
      room.emit(RoomEvent.ParticipantConnected, nextParticipant);
      expect(roomIO.linkedParticipant).toBe(nextParticipant);
      expect(session._onRoomIOParticipantLinked).toHaveBeenCalledWith(nextParticipant);
      await roomIO.close();
    },
  );

  it.each(['before_join', 'reselect_same', 'reselect_other'] as const)(
    'waits without a linked participant for %s and restarts after selection',
    async (reason) => {
      const room = createFakeRoom();
      const session = createFakeSession();
      const caller = createParticipant('caller');
      const replacement = createParticipant('replacement');
      if (reason !== 'before_join') room.remoteParticipants.set(caller.identity, caller);
      if (reason === 'reselect_other') {
        room.remoteParticipants.set(replacement.identity, replacement);
      }
      const roomIO = new RoomIO({
        agentSession: session as unknown as RoomIOArgs['agentSession'],
        room: room as unknown as RoomIOArgs['room'],
        participant: caller.identity,
        inputOptions: { audioEnabled: false, textEnabled: false },
        outputOptions: { audioEnabled: false, transcriptionEnabled: false },
      });
      roomIO.start();
      roomIO.setParticipant(caller.identity);

      if (reason === 'before_join') {
        expect(roomIO.linkedParticipant).toBeUndefined();
        room.remoteParticipants.set(caller.identity, caller);
        room.emit(RoomEvent.ParticipantConnected, caller);
        expect(roomIO.linkedParticipant).toBe(caller);
      } else {
        roomIO.unsetParticipant();
        expect(roomIO.linkedParticipant).toBeUndefined();
        const nextParticipant = reason === 'reselect_same' ? caller : replacement;
        roomIO.setParticipant(nextParticipant.identity);
        expect(roomIO.linkedParticipant).toBe(nextParticipant);
        expect(session._onRoomIOParticipantLinked).toHaveBeenLastCalledWith(nextParticipant);
      }

      await roomIO.close();
    },
  );

  it.each([null, 'waiting-caller'] as const)(
    'setParticipant wakes the initial waiter from %s',
    async (initialIdentity) => {
      const room = createFakeRoom();
      const session = createFakeSession();
      const caller = createParticipant('caller');
      const roomIO = new RoomIO({
        agentSession: session as unknown as RoomIOArgs['agentSession'],
        room: room as unknown as RoomIOArgs['room'],
        participant: initialIdentity,
        inputOptions: { audioEnabled: false, textEnabled: false },
        outputOptions: { audioEnabled: false, transcriptionEnabled: false },
      });
      roomIO.start();
      room.isConnected = true;
      room.emit(RoomEvent.ConnectionStateChanged, ConnectionState.CONN_CONNECTED);
      room.remoteParticipants.set(caller.identity, caller);

      roomIO.setParticipant(caller.identity);
      await vi.waitFor(() => expect(roomIO.linkedParticipant).toBe(caller));
      await roomIO.close();
    },
  );

  it.each([true, false])(
    'follows a participant switch when replacementConnected=%s',
    async (replacementConnected) => {
      const room = createFakeRoom();
      const session = createFakeSession();
      const caller = createParticipant('caller');
      const replacement = createParticipant('replacement');
      room.remoteParticipants.set(caller.identity, caller);
      if (replacementConnected) room.remoteParticipants.set(replacement.identity, replacement);
      const roomIO = new RoomIO({
        agentSession: session as unknown as RoomIOArgs['agentSession'],
        room: room as unknown as RoomIOArgs['room'],
        participant: caller.identity,
        inputOptions: { audioEnabled: false, textEnabled: false },
        outputOptions: { audioEnabled: false, transcriptionEnabled: false },
      });
      roomIO.start();
      roomIO.setParticipant(caller.identity);
      session.resetAwayTimer.mockClear();

      roomIO.setParticipant(replacement.identity);
      room.emit(RoomEvent.DtmfReceived, 1, '1', caller);
      expect(session.resetAwayTimer).not.toHaveBeenCalled();

      if (!replacementConnected) {
        room.emit(RoomEvent.DtmfReceived, 2, '2', replacement);
        expect(session.resetAwayTimer).not.toHaveBeenCalled();
        room.remoteParticipants.set(replacement.identity, replacement);
        room.emit(RoomEvent.ParticipantConnected, replacement);
      }
      expect(roomIO.linkedParticipant).toBe(replacement);
      room.emit(RoomEvent.DtmfReceived, 2, '2', replacement);
      expect(session.resetAwayTimer).toHaveBeenCalledOnce();
      room.emit(RoomEvent.DtmfReceived, 1, '1', caller);
      expect(session.resetAwayTimer).toHaveBeenCalledOnce();

      await roomIO.close();
      expect(room.listenerCount(RoomEvent.DtmfReceived)).toBe(0);
    },
  );
});

describe('RoomIO agent state attributes', () => {
  it('handles a failed update and publishes later state changes', async () => {
    const error = new Error('attribute update failed');
    const setAttributes = vi.fn().mockRejectedValueOnce(error).mockResolvedValue(undefined);
    const room = {
      ...createFakeRoom(),
      localParticipant: { identity: 'agent', setAttributes },
    };
    const session = createFakeSession();
    const roomIO = new RoomIO({
      agentSession: session as unknown as RoomIOArgs['agentSession'],
      room: room as unknown as RoomIOArgs['room'],
      inputOptions: { audioEnabled: false, textEnabled: false },
      outputOptions: { audioEnabled: false, transcriptionEnabled: false },
    });
    const errorSpy = vi.spyOn(log(), 'error');

    try {
      roomIO.start();
      room.isConnected = true;
      session.emit(AgentSessionEventTypes.AgentStateChanged, {
        oldState: 'listening',
        newState: 'speaking',
      });
      await vi.waitFor(() => {
        expect(errorSpy).toHaveBeenCalledWith(error, 'Failed to update agent state attributes');
      });

      session.emit(AgentSessionEventTypes.AgentStateChanged, {
        oldState: 'speaking',
        newState: 'listening',
      });
      expect(setAttributes).toHaveBeenNthCalledWith(1, { 'lk.agent.state': 'speaking' });
      expect(setAttributes).toHaveBeenNthCalledWith(2, { 'lk.agent.state': 'listening' });
    } finally {
      await roomIO.close();
      errorSpy.mockRestore();
    }

    session.emit(AgentSessionEventTypes.AgentStateChanged, { newState: 'speaking' });
    expect(setAttributes).toHaveBeenCalledTimes(2);
  });
});

describe('RoomIO native audio output', () => {
  it('uses a 200ms source queue by default', async () => {
    const room = createFakeRoom();
    const session = createFakeSession();
    const roomIO = new RoomIO({
      agentSession: session as unknown as RoomIOArgs['agentSession'],
      room: room as unknown as RoomIOArgs['room'],
      inputOptions: { audioEnabled: false, textEnabled: false },
      outputOptions: { transcriptionEnabled: false },
    });

    roomIO.start();

    const participantAudioOutput = Reflect.get(roomIO, 'participantAudioOutput');
    expect(Reflect.get(participantAudioOutput, 'options').queueSizeMs).toBe(200);
    expect(Reflect.get(participantAudioOutput, 'audioSource').queueSize).toBe(200);

    await roomIO.close();
  });
});

class ExternalAudioOutput extends AudioOutput {
  readonly capturedFrames: AudioFrame[] = [];
  readonly close = vi.fn(async () => {});

  constructor() {
    super(24000);
  }

  override async captureFrame(frame: AudioFrame): Promise<void> {
    await super.captureFrame(frame);
    this.capturedFrames.push(frame);
  }

  clearBuffer(): void {}
}

describe('RoomIO external audio output', () => {
  it('preserves synchronized external audio without taking ownership', async () => {
    const room = createFakeRoom();
    const session = createFakeSession();
    const externalOutput = new ExternalAudioOutput();
    session.output.audio = externalOutput;
    const roomIO = new RoomIO({
      agentSession: session as unknown as RoomIOArgs['agentSession'],
      room: room as unknown as RoomIOArgs['room'],
      inputOptions: { audioEnabled: false, textEnabled: false },
    });

    roomIO.start();

    expect(Reflect.get(roomIO, 'participantAudioOutput')).toBeUndefined();
    expect(session.output.audio).not.toBe(externalOutput);
    const frame = new AudioFrame(new Int16Array(240), 24000, 1, 240);
    await session.output.audio!.captureFrame(frame);
    expect(externalOutput.capturedFrames).toEqual([frame]);

    await roomIO.close();
    expect(externalOutput.close).not.toHaveBeenCalled();
  });

  it.each([
    { transcriptionEnabled: false, syncTranscription: true },
    { transcriptionEnabled: true, syncTranscription: false },
  ])(
    'preserves external audio unchanged when transcription=$transcriptionEnabled and sync=$syncTranscription',
    async ({ transcriptionEnabled, syncTranscription }) => {
      const room = createFakeRoom();
      const session = createFakeSession();
      const externalOutput = new ExternalAudioOutput();
      session.output.audio = externalOutput;
      const roomIO = new RoomIO({
        agentSession: session as unknown as RoomIOArgs['agentSession'],
        room: room as unknown as RoomIOArgs['room'],
        inputOptions: { audioEnabled: false, textEnabled: false },
        outputOptions: { transcriptionEnabled, syncTranscription },
      });

      roomIO.start();

      expect(session.output.audio).toBe(externalOutput);
      expect(Reflect.get(roomIO, 'participantAudioOutput')).toBeUndefined();

      await roomIO.close();
      expect(externalOutput.close).not.toHaveBeenCalled();
    },
  );
});

class ExternalAudioInput extends AudioInput {
  override close = vi.fn(async () => {});
}

class ExternalTextOutput extends TextOutput {
  readonly captured: (string | TimedString)[] = [];

  async captureText(text: string | TimedString): Promise<void> {
    this.captured.push(text);
  }

  flush(): void {}
}

describe('RoomIO external audio input', () => {
  it('preserves a pre-set input.audio without creating a participant input', async () => {
    const room = createFakeRoom();
    const session = createFakeSession();
    const externalInput = new ExternalAudioInput();
    session.input.audio = externalInput;
    const roomIO = new RoomIO({
      agentSession: session as unknown as RoomIOArgs['agentSession'],
      room: room as unknown as RoomIOArgs['room'],
      inputOptions: { textEnabled: false },
      outputOptions: { audioEnabled: false, transcriptionEnabled: false },
    });

    roomIO.start();

    expect(Reflect.get(roomIO, 'audioInput')).toBeUndefined();
    expect(session.input.audio).toBe(externalInput);

    await roomIO.close();
    expect(externalInput.close).not.toHaveBeenCalled();
  });
});

describe('RoomIO external transcription output', () => {
  it('preserves a pre-set output.transcription and skips the room transcription outputs', async () => {
    const room = createFakeRoom();
    const session = createFakeSession();
    const externalText = new ExternalTextOutput();
    session.output.transcription = externalText;
    const roomIO = new RoomIO({
      agentSession: session as unknown as RoomIOArgs['agentSession'],
      room: room as unknown as RoomIOArgs['room'],
      inputOptions: { audioEnabled: false, textEnabled: false },
      outputOptions: { audioEnabled: false },
    });

    roomIO.start();

    expect(session.output.transcription).toBe(externalText);
    expect(Reflect.get(roomIO, 'userTranscriptOutput')).toBeUndefined();
    expect(Reflect.get(roomIO, 'agentTranscriptOutput')).toBeUndefined();
    expect(Reflect.get(roomIO, 'transcriptionSynchronizer')).toBeUndefined();

    await roomIO.close();
  });
});

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
