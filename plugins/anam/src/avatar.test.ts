// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { initializeLogger, voice } from '@livekit/agents';
import type { Room } from '@livekit/rtc-node';
import { TrackKind } from '@livekit/rtc-node';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AvatarSession } from './avatar.js';

type DataStreamAudioOutputInternals = {
  waitPlaybackStart: boolean;
};

describe('Anam AvatarSession', () => {
  beforeAll(() => {
    initializeLogger({ pretty: false, level: 'silent' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('calls base AvatarSession.start first', async () => {
    const sentinel = new Error('super-start-called');
    const superStartSpy = vi
      .spyOn(voice.AvatarSession.prototype, 'start')
      .mockRejectedValue(sentinel);

    const avatar = new AvatarSession({
      personaConfig: {
        personaId: 'persona-test',
      },
    });

    await expect(
      avatar.start({ _started: false, output: { audio: null } } as any, {} as any),
    ).rejects.toThrow('super-start-called');
    expect(superStartSpy).toHaveBeenCalledTimes(1);
  });

  it('configures DataStreamAudioOutput to wait for remote playback started', async () => {
    vi.spyOn(voice.AvatarSession.prototype, 'start').mockResolvedValue(undefined);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ sessionId: 'session-test' }))),
    );

    const avatar = new AvatarSession({
      personaConfig: { name: 'Test', avatarId: 'avatar-1' },
      apiKey: 'anam-key',
      apiUrl: 'https://anam.test',
    });

    const remoteParticipant = {
      identity: 'anam-avatar-agent',
      trackPublications: new Map([['video', { kind: TrackKind.KIND_VIDEO }]]),
    };
    const room = {
      name: 'test-room',
      isConnected: true,
      localParticipant: { identity: 'local-agent', registerRpcMethod: vi.fn() },
      remoteParticipants: new Map([[remoteParticipant.identity, remoteParticipant]]),
      on: vi.fn(),
      off: vi.fn(),
    };
    const agentSession = {
      _started: false,
      output: { audio: null },
    } as unknown as voice.AgentSession;

    await avatar.start(agentSession, room as unknown as Room, {
      livekitUrl: 'wss://livekit.example.com',
      livekitApiKey: 'livekit-api-key',
      livekitApiSecret: 'livekit-api-secret',
    });

    const audioOutput = agentSession.output.audio;
    expect(audioOutput).toBeInstanceOf(voice.DataStreamAudioOutput);
    expect((audioOutput as unknown as DataStreamAudioOutputInternals).waitPlaybackStart).toBe(true);
  });
});
