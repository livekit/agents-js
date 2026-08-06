// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { voice } from '@livekit/agents';
import type { Room } from '@livekit/rtc-node';
import { TrackKind } from '@livekit/rtc-node';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProtofaceAPI } from './api.js';
import { AvatarSession } from './avatar.js';

type DataStreamAudioOutputInternals = {
  destinationIdentity: string;
  sampleRate: number;
  waitRemoteTrack?: TrackKind;
};

function fakeRoom(): Room {
  const emitter = new EventEmitter();
  const remoteParticipant = {
    identity: 'protoface-avatar-agent',
    trackPublications: new Map([['video', { kind: TrackKind.KIND_VIDEO }]]),
  };

  return {
    name: 'test-room',
    isConnected: true,
    localParticipant: {
      identity: 'local-agent',
      registerRpcMethod: vi.fn(),
    },
    remoteParticipants: new Map([[remoteParticipant.identity, remoteParticipant]]),
    on: vi.fn((event: string | symbol, listener: (...args: unknown[]) => void) => {
      emitter.on(event, listener);
      return emitter;
    }),
    off: vi.fn((event: string | symbol, listener: (...args: unknown[]) => void) => {
      emitter.off(event, listener);
      return emitter;
    }),
  } as unknown as Room;
}

function fakeAgentSession(): voice.AgentSession {
  const emitter = new EventEmitter();
  return {
    _started: true,
    output: { audio: null as voice.AudioOutput | null },
    on: vi.fn((event: string | symbol, listener: (...args: unknown[]) => void) => {
      emitter.on(event, listener);
      return emitter;
    }),
    off: vi.fn((event: string | symbol, listener: (...args: unknown[]) => void) => {
      emitter.off(event, listener);
      return emitter;
    }),
  } as unknown as voice.AgentSession;
}

describe('Protoface AvatarSession', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    voice.DataStreamAudioOutput._playbackFinishedRpcRegistered = false;
    voice.DataStreamAudioOutput._playbackFinishedHandlers = {};
    voice.DataStreamAudioOutput._playbackStartedRpcRegistered = false;
    voice.DataStreamAudioOutput._playbackStartedHandlers = {};
  });

  it('calls base AvatarSession.start first', async () => {
    const sentinel = new Error('super-start-called');
    const superStartSpy = vi
      .spyOn(voice.AvatarSession.prototype, 'start')
      .mockRejectedValue(sentinel);

    const avatar = new AvatarSession({ apiKey: 'protoface-key' });

    await expect(avatar.start(fakeAgentSession(), fakeRoom())).rejects.toThrow(
      'super-start-called',
    );
    expect(superStartSpy).toHaveBeenCalledTimes(1);
  });

  it('starts a Protoface session and routes agent audio to the avatar', async () => {
    vi.spyOn(voice.AvatarSession.prototype, 'start').mockResolvedValue(undefined);
    vi.spyOn(voice.AvatarSession.prototype, 'aclose').mockResolvedValue(undefined);
    const startSessionSpy = vi
      .spyOn(ProtofaceAPI.prototype, 'startSession')
      .mockResolvedValue({ id: 'protoface-session-1' });
    const endSessionSpy = vi.spyOn(ProtofaceAPI.prototype, 'endSession').mockResolvedValue({});

    const avatar = new AvatarSession({
      apiKey: 'protoface-key',
      avatarId: 'avatar-1',
      maxDurationMs: 120_000,
    });
    const agentSession = fakeAgentSession();

    await avatar.start(agentSession, fakeRoom(), {
      livekitUrl: 'wss://livekit.example.com',
      livekitApiKey: 'livekit-api-key',
      livekitApiSecret: 'livekit-api-secret',
    });

    expect(avatar.sessionId).toBe('protoface-session-1');
    expect(startSessionSpy).toHaveBeenCalledWith({
      avatarId: 'avatar-1',
      transport: expect.objectContaining({
        type: 'livekit',
        url: 'wss://livekit.example.com',
        room_name: 'test-room',
        worker_identity: 'protoface-avatar-agent',
        audio_source: 'data_stream',
        worker_token: expect.any(String),
      }),
      maxDurationMs: 120_000,
    });

    const audioOutput = agentSession.output.audio;
    expect(audioOutput).toBeInstanceOf(voice.DataStreamAudioOutput);
    expect((audioOutput as unknown as DataStreamAudioOutputInternals).destinationIdentity).toBe(
      'protoface-avatar-agent',
    );
    expect((audioOutput as unknown as DataStreamAudioOutputInternals).sampleRate).toBe(16000);
    expect((audioOutput as unknown as DataStreamAudioOutputInternals).waitRemoteTrack).toBe(
      TrackKind.KIND_VIDEO,
    );

    await avatar.aclose();
    expect(endSessionSpy).toHaveBeenCalledWith('protoface-session-1');
    expect(avatar.sessionId).toBeNull();
  });
});
