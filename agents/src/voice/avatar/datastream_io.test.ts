// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AudioFrame, Room } from '@livekit/rtc-node';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initializeLogger } from '../../log.js';
import { DataStreamAudioOutput } from './datastream_io.js';

initializeLogger({ pretty: false, level: 'silent' });

const DESTINATION = 'avatar-worker';

function fakeRoom({ connected = true } = {}) {
  const emitter = new EventEmitter();
  const writer = { write: vi.fn(async () => {}), close: vi.fn(async () => {}) };
  const room = Object.assign(emitter, {
    isConnected: connected,
    localParticipant: {
      identity: 'agent',
      registerRpcMethod: vi.fn(),
      performRpc: vi.fn(async () => ''),
      streamBytes: vi.fn(async () => writer),
    },
    remoteParticipants: new Map([
      [DESTINATION, { identity: DESTINATION, trackPublications: new Map() }],
    ]),
  });
  return { room: room as unknown as Room, writer };
}

function frame(): AudioFrame {
  return {
    data: new Int16Array(480),
    sampleRate: 24000,
    channels: 1,
    samplesPerChannel: 480,
  } as unknown as AudioFrame;
}

describe('DataStreamAudioOutput.aclose', () => {
  afterEach(() => {
    DataStreamAudioOutput._playbackFinishedRpcRegistered = false;
    DataStreamAudioOutput._playbackFinishedHandlers = {};
    DataStreamAudioOutput._playbackStartedRpcRegistered = false;
    DataStreamAudioOutput._playbackStartedHandlers = {};
  });

  it('releases a capture still waiting for the room to connect', async () => {
    const { room } = fakeRoom({ connected: false });
    const output = new DataStreamAudioOutput({ room, destinationIdentity: DESTINATION });

    const capture = output.captureFrame(frame());
    await output.aclose();

    await expect(capture).rejects.toThrow();
  });

  it('removes RPC handlers even when closing the stream writer fails', async () => {
    const { room, writer } = fakeRoom();
    writer.close.mockRejectedValueOnce(new Error('transport down'));
    const output = new DataStreamAudioOutput({ room, destinationIdentity: DESTINATION });
    await output.captureFrame(frame());
    expect(DataStreamAudioOutput._playbackFinishedHandlers[DESTINATION]).toBeDefined();

    await expect(output.aclose()).rejects.toThrow('transport down');

    expect(DataStreamAudioOutput._playbackFinishedHandlers[DESTINATION]).toBeUndefined();
  });

  it('settles pending playout as interrupted and rejects later captures', async () => {
    const { room } = fakeRoom();
    const output = new DataStreamAudioOutput({ room, destinationIdentity: DESTINATION });
    await output.captureFrame(frame());
    output.flush();

    await output.aclose();

    await expect(output.waitForPlayout()).resolves.toMatchObject({ interrupted: true });
    await expect(output.captureFrame(frame())).rejects.toThrow('closed');
  });
});
