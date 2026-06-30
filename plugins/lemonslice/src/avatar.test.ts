// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { initializeLogger, voice } from '@livekit/agents';
import { type Room, TrackKind } from '@livekit/rtc-node';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AvatarSession } from './avatar.js';

type DataStreamAudioOutputInternals = {
  waitPlaybackStart: boolean;
};

describe('LemonSlice AvatarSession', () => {
  beforeEach(() => {
    initializeLogger({ pretty: false });
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    voice.DataStreamAudioOutput._playbackFinishedRpcRegistered = false;
    voice.DataStreamAudioOutput._playbackFinishedHandlers = {};
    voice.DataStreamAudioOutput._playbackStartedRpcRegistered = false;
    voice.DataStreamAudioOutput._playbackStartedHandlers = {};
  });

  it('merges extraPayload into the session creation request body', async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ session_id: 'test-session-id' }),
    } as Response);

    const avatar = new AvatarSession({
      apiKey: 'test-api-key',
      agentImageUrl: 'https://example.com/avatar.png',
      extraPayload: {
        aspect_ratio: '9x16',
      },
    });

    await (
      avatar as unknown as {
        startAgent(
          livekitUrl: string,
          livekitToken: string,
          livekitSessionId: string,
        ): Promise<void>;
      }
    ).startAgent('wss://livekit.example.com', 'livekit-token', 'room-session-id');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://lemonslice.com/api/liveai/sessions',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          transport_type: 'livekit',
          properties: {
            livekit_url: 'wss://livekit.example.com',
            livekit_token: 'livekit-token',
            livekit_session_id: 'room-session-id',
          },
          agent_image_url: 'https://example.com/avatar.png',
          aspect_ratio: '9x16',
        }),
      }),
    );
  });

  it('keeps the request body unchanged when extraPayload is omitted', async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ session_id: 'test-session-id' }),
    } as Response);

    const avatar = new AvatarSession({
      apiKey: 'test-api-key',
      agentImageUrl: 'https://example.com/avatar.png',
    });

    await (
      avatar as unknown as {
        startAgent(
          livekitUrl: string,
          livekitToken: string,
          livekitSessionId: string,
        ): Promise<void>;
      }
    ).startAgent('wss://livekit.example.com', 'livekit-token', 'room-session-id');

    const requestInit = mockFetch.mock.calls[0]?.[1];
    const body = JSON.parse(String(requestInit?.body));

    expect(body).toEqual({
      transport_type: 'livekit',
      properties: {
        livekit_url: 'wss://livekit.example.com',
        livekit_token: 'livekit-token',
        livekit_session_id: 'room-session-id',
      },
      agent_image_url: 'https://example.com/avatar.png',
    });
    expect(body).not.toHaveProperty('aspect_ratio');
  });

  it('calls base AvatarSession.start first', async () => {
    const sentinel = new Error('super-start-called');
    const superStartSpy = vi
      .spyOn(voice.AvatarSession.prototype, 'start')
      .mockRejectedValue(sentinel);

    const avatar = new AvatarSession({
      apiKey: 'test-api-key',
      agentImageUrl: 'https://example.com/avatar.png',
    });

    await expect(
      avatar.start(
        { _started: false, output: { audio: null } } as unknown as voice.AgentSession,
        {} as unknown as Room,
      ),
    ).rejects.toThrow('super-start-called');
    expect(superStartSpy).toHaveBeenCalledTimes(1);
  });

  it('configures DataStreamAudioOutput to wait for remote playback started', async () => {
    vi.spyOn(voice.AvatarSession.prototype, 'start').mockResolvedValue(undefined);

    const avatar = new AvatarSession({
      apiKey: 'test-api-key',
      agentImageUrl: 'https://example.com/avatar.png',
    });
    vi.spyOn(
      avatar as unknown as {
        startAgent(
          livekitUrl: string,
          livekitToken: string,
          livekitSessionId: string,
        ): Promise<string>;
      },
      'startAgent',
    ).mockResolvedValue('test-session-id');

    const remoteParticipant = {
      identity: 'lemonslice-avatar-agent',
      trackPublications: new Map([['video', { kind: TrackKind.KIND_VIDEO }]]),
    };
    const room = {
      name: 'test-room',
      sid: 'room-session-id',
      isConnected: true,
      localParticipant: {
        identity: 'local-agent',
        registerRpcMethod: vi.fn(),
      },
      remoteParticipants: new Map([[remoteParticipant.identity, remoteParticipant]]),
      on: vi.fn(),
      off: vi.fn(),
    };
    const agentSession = {
      _started: false,
      output: { audio: null },
    } as unknown as voice.AgentSession;

    const sessionId = await avatar.start(agentSession, room as unknown as Room, {
      livekitUrl: 'wss://livekit.example.com',
      livekitApiKey: 'livekit-api-key',
      livekitApiSecret: 'livekit-api-secret',
    });

    expect(sessionId).toBe('test-session-id');
    const audioOutput = agentSession.output.audio;
    expect(audioOutput).toBeInstanceOf(voice.DataStreamAudioOutput);
    expect((audioOutput as unknown as DataStreamAudioOutputInternals).waitPlaybackStart).toBe(true);
  });
});
