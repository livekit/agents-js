// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioFrame, ByteStreamWriter, Room } from '@livekit/rtc-node';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioOutput, type PlaybackFinishedEvent } from '../io.js';
import { DataStreamAudioOutput } from './datastream_io.js';

const { logger } = vi.hoisted(() => ({
  logger: {
    debug: vi.fn(),
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

  Object.defineProperties(room, {
    isConnected: { value: true },
    localParticipant: {
      value: {
        performRpc,
        registerRpcMethod: vi.fn(),
        streamBytes: vi.fn(async () => createByteStreamWriter()),
      },
    },
    remoteParticipants: { value: new Map([[avatar.identity, avatar]]) },
  });

  return { room, performRpc };
}

function createFrame(): AudioFrame {
  return new AudioFrame(new Int16Array(160), 8000, 1, 160);
}

function nextTick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('DataStreamAudioOutput.clearBuffer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    DataStreamAudioOutput._playbackFinishedRpcRegistered = false;
    DataStreamAudioOutput._playbackFinishedHandlers = {};
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
