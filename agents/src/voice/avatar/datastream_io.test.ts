// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioFrame, ByteStreamWriter, Room, RoomEvent } from '@livekit/rtc-node';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioOutput, type PlaybackFinishedEvent } from '../io.js';
import { DataStreamAudioOutput } from './datastream_io.js';

const { logger } = vi.hoisted(() => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock('../../log.js', () => ({
  log: () => logger,
}));

function createByteStreamWriter(): ByteStreamWriter {
  return new ByteStreamWriter(new WritableStream<Uint8Array>(), {
    streamId: 'test-stream',
    mimeType: 'application/octet-stream',
    topic: 'lk.audio_stream',
    timestamp: 0,
    name: 'audio',
  });
}

function createRoom(performRpcImpl: () => Promise<string>) {
  const avatar = { identity: 'avatar' };
  const room = new Room();
  const performRpc = vi.fn(performRpcImpl);
  const registerRpcMethod = vi.fn<NonNullable<Room['localParticipant']>['registerRpcMethod']>();

  Object.defineProperties(room, {
    isConnected: { value: true },
    localParticipant: {
      value: {
        performRpc,
        registerRpcMethod,
        streamBytes: vi.fn(async () => createByteStreamWriter()),
      },
    },
    remoteParticipants: { value: new Map([[avatar.identity, avatar]]) },
  });

  return { room, performRpc, registerRpcMethod };
}

function createFrame(): AudioFrame {
  return new AudioFrame(new Int16Array(160), 8000, 1, 160);
}

function nextTick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('DataStreamAudioOutput', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    DataStreamAudioOutput._playbackFinishedRpcRegistered = false;
    DataStreamAudioOutput._playbackFinishedHandlers = {};
    DataStreamAudioOutput._playbackStartedRpcRegistered = false;
    DataStreamAudioOutput._playbackStartedHandlers = {};
  });

  it.each([
    { waitPlaybackStart: undefined, estimated: true },
    { waitPlaybackStart: true, estimated: false },
  ])('reports whether playback start is estimated ($waitPlaybackStart)', (options) => {
    const { room } = createRoom(async () => 'ok');
    const output = new DataStreamAudioOutput({
      room,
      destinationIdentity: 'avatar',
      waitPlaybackStart: options.waitPlaybackStart,
    });
    expect(output._playbackStartIsEstimated).toBe(options.estimated);
  });

  it.each([
    { position: 0.02, payload: { playback_position: 0.02, interrupted: true } },
    { position: 0, payload: { interrupted: true } },
  ])('reports playback position $position from the finish RPC', async ({ position, payload }) => {
    const { room, registerRpcMethod } = createRoom(async () => 'ok');
    const output = new DataStreamAudioOutput({ room, destinationIdentity: 'avatar' });
    await output.captureFrame(createFrame());
    output.flush();

    const method = 'lk.playback_finished';
    const handler = registerRpcMethod.mock.calls.find(([name]) => name === method)?.[1];
    expect(handler).toBeDefined();
    await expect(
      handler!({
        method,
        requestId: 'test',
        callerIdentity: 'avatar',
        payload: JSON.stringify(payload),
        responseTimeout: 1000,
      }),
    ).resolves.toBe('ok');
    await expect(output.waitForPlayout()).resolves.toMatchObject({
      playbackPosition: position,
      interrupted: true,
    });
  });

  it('settles pending playout when the clear-buffer RPC rejects', async () => {
    const error = new Error('Failed to send');
    const { room, performRpc } = createRoom(() => Promise.reject(error));
    const output = new DataStreamAudioOutput({
      room,
      destinationIdentity: 'avatar',
    });

    await output.captureFrame(createFrame());
    output.flush();

    const playout = output.waitForPlayout();
    output.clearBuffer();

    await expect(playout).resolves.toEqual({
      playbackPosition: 0,
      interrupted: true,
    });
    expect(performRpc).toHaveBeenCalledExactlyOnceWith({
      destinationIdentity: 'avatar',
      method: 'lk.clear_buffer',
      payload: '',
    });
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
      { error, destinationIdentity: 'avatar' },
      'failed to perform clear buffer rpc',
    );
  });

  it('does not let a late rejection settle a newer segment', async () => {
    let rejectRpc: (reason?: unknown) => void = () => {};
    const rpc = new Promise<string>((_resolve, reject) => {
      rejectRpc = reject;
    });
    const { room } = createRoom(() => rpc);
    const output = new DataStreamAudioOutput({
      room,
      destinationIdentity: 'avatar',
    });

    await output.captureFrame(createFrame());
    output.flush();
    output.clearBuffer();

    output.onPlaybackFinished({ playbackPosition: 0.01, interrupted: true });

    await nextTick();
    await output.captureFrame(createFrame());
    output.flush();
    const secondPlayout = output.waitForPlayout();

    rejectRpc(new Error('Failed to send'));
    await vi.waitFor(() => expect(logger.warn).toHaveBeenCalledOnce());

    const secondEvent = { playbackPosition: 0.02, interrupted: false };
    output.onPlaybackFinished(secondEvent);
    await expect(secondPlayout).resolves.toEqual(secondEvent);
  });

  it('settles every segment pending when clearBuffer was called', async () => {
    const { room } = createRoom(() => Promise.reject(new Error('Failed to send')));
    const output = new DataStreamAudioOutput({
      room,
      destinationIdentity: 'avatar',
    });
    const playbackEvents: PlaybackFinishedEvent[] = [];
    output.on(AudioOutput.EVENT_PLAYBACK_FINISHED, (event) => playbackEvents.push(event));

    await output.captureFrame(createFrame());
    output.flush();
    await nextTick();
    await output.captureFrame(createFrame());
    output.flush();

    const playout = output.waitForPlayout();
    output.clearBuffer();
    await expect(playout).resolves.toEqual({ playbackPosition: 0, interrupted: true });

    expect(playbackEvents).toEqual([
      { playbackPosition: 0, interrupted: true },
      { playbackPosition: 0, interrupted: true },
    ]);
  });
});

describe('DataStreamAudioOutput when the destination participant leaves', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    DataStreamAudioOutput._playbackFinishedRpcRegistered = false;
    DataStreamAudioOutput._playbackFinishedHandlers = {};
  });

  function leave(room: Room, identity: string): void {
    const participant = room.remoteParticipants.get(identity) ?? { identity };
    room.remoteParticipants.delete(identity);
    room.emit(RoomEvent.ParticipantDisconnected, participant as never);
  }

  function rejoin(room: Room, identity: string): void {
    const participant = { identity };
    room.remoteParticipants.set(identity, participant as never);
    room.emit(RoomEvent.ParticipantConnected, participant as never);
  }

  function disconnectListeners(room: Room): number {
    return room.listenerCount(RoomEvent.ParticipantDisconnected);
  }

  it('settles a flushed segment as interrupted at the pushed duration', async () => {
    const { room } = createRoom(() => Promise.resolve(''));
    const output = new DataStreamAudioOutput({ room, destinationIdentity: 'avatar' });

    await output.captureFrame(createFrame());
    output.flush();
    const playout = output.waitForPlayout();

    leave(room, 'avatar');

    await expect(playout).resolves.toEqual({ playbackPosition: 0.02, interrupted: true });
  });

  it('ignores other participants leaving', async () => {
    const { room } = createRoom(() => Promise.resolve(''));
    const output = new DataStreamAudioOutput({ room, destinationIdentity: 'avatar' });

    await output.captureFrame(createFrame());
    output.flush();
    let settled = false;
    void output.waitForPlayout().then(() => {
      settled = true;
    });

    leave(room, 'someone-else');
    await nextTick();

    expect(settled).toBe(false);
  });

  it('finishes a segment that was still being captured when it is flushed', async () => {
    const { room } = createRoom(() => Promise.resolve(''));
    const output = new DataStreamAudioOutput({ room, destinationIdentity: 'avatar' });
    const playbackEvents: PlaybackFinishedEvent[] = [];
    output.on(AudioOutput.EVENT_PLAYBACK_FINISHED, (event) => playbackEvents.push(event));

    await output.captureFrame(createFrame());
    leave(room, 'avatar');
    expect(playbackEvents).toEqual([]);

    await output.captureFrame(createFrame());
    output.flush();

    expect(playbackEvents).toEqual([{ playbackPosition: 0.04, interrupted: true }]);
  });

  it('settles a segment captured after the avatar left at its flush', async () => {
    const { room } = createRoom(() => Promise.resolve(''));
    const output = new DataStreamAudioOutput({ room, destinationIdentity: 'avatar' });
    const playbackEvents: PlaybackFinishedEvent[] = [];
    output.on(AudioOutput.EVENT_PLAYBACK_FINISHED, (event) => playbackEvents.push(event));

    await output.captureFrame(createFrame());
    output.flush();
    leave(room, 'avatar');
    await nextTick();

    await output.captureFrame(createFrame());
    await output.captureFrame(createFrame());
    output.flush();

    expect(output.pendingPlayoutSegments).toBe(0);
    expect(playbackEvents).toEqual([
      { playbackPosition: 0.02, interrupted: true },
      { playbackPosition: 0.04, interrupted: true },
    ]);
  });

  it('waits for playback again once the avatar rejoins', async () => {
    const { room } = createRoom(() => Promise.resolve(''));
    const output = new DataStreamAudioOutput({ room, destinationIdentity: 'avatar' });

    await output.captureFrame(createFrame());
    output.flush();
    leave(room, 'avatar');
    rejoin(room, 'avatar');
    await nextTick();

    await output.captureFrame(createFrame());
    output.flush();

    expect(output.pendingPlayoutSegments).toBe(1);
  });

  it('settles each pending segment at its own duration', async () => {
    const { room } = createRoom(() => Promise.resolve(''));
    const output = new DataStreamAudioOutput({ room, destinationIdentity: 'avatar' });
    const playbackEvents: PlaybackFinishedEvent[] = [];
    output.on(AudioOutput.EVENT_PLAYBACK_FINISHED, (event) => playbackEvents.push(event));

    await output.captureFrame(createFrame());
    output.flush();
    await nextTick();
    for (let i = 0; i < 3; i++) await output.captureFrame(createFrame());
    output.flush();

    leave(room, 'avatar');

    expect(playbackEvents).toEqual([
      { playbackPosition: 0.02, interrupted: true },
      { playbackPosition: 0.06, interrupted: true },
    ]);
  });

  it('stops listening for departures when detached with nothing pending', () => {
    const { room } = createRoom(() => Promise.resolve(''));
    const output = new DataStreamAudioOutput({ room, destinationIdentity: 'avatar' });
    expect(disconnectListeners(room)).toBe(1);

    output.onDetached();
    expect(disconnectListeners(room)).toBe(0);

    output.onAttached();
    expect(disconnectListeners(room)).toBe(1);
  });

  it('keeps listening while detached with playout pending, then stops once it settles', async () => {
    const { room } = createRoom(() => Promise.resolve(''));
    const output = new DataStreamAudioOutput({ room, destinationIdentity: 'avatar' });

    await output.captureFrame(createFrame());
    output.flush();
    output.onDetached();
    expect(disconnectListeners(room)).toBe(1);

    leave(room, 'avatar');

    expect(output.pendingPlayoutSegments).toBe(0);
    expect(disconnectListeners(room)).toBe(0);
  });
});
