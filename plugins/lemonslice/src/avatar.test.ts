// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { initializeLogger, voice } from '@livekit/agents';
import { type Room, TrackKind } from '@livekit/rtc-node';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AvatarSession } from './avatar.js';
import { MeetingAudioInput } from './meeting/audio.js';
import { MeetingChatRelay } from './meeting/chat.js';

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
        startAgent(livekitUrl: string, livekitToken: string): Promise<void>;
      }
    ).startAgent('wss://livekit.example.com', 'livekit-token');

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
          },
          agent_image_url: 'https://example.com/avatar.png',
          aspect_ratio: '9x16',
        }),
      }),
    );
  });

  it('converts camelCase extraPayload keys to snake_case', async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ session_id: 'test-session-id' }),
    } as Response);

    const avatar = new AvatarSession({
      apiKey: 'test-api-key',
      agentImageUrl: 'https://example.com/avatar.png',
      extraPayload: {
        aspectRatio: '9x16',
        responseDoneTimeout: 2,
      },
    });

    await (
      avatar as unknown as {
        startAgent(livekitUrl: string, livekitToken: string): Promise<void>;
      }
    ).startAgent('wss://livekit.example.com', 'livekit-token');

    const requestInit = mockFetch.mock.calls[0]?.[1];
    const body = JSON.parse(String(requestInit?.body));
    expect(body.aspect_ratio).toBe('9x16');
    expect(body).not.toHaveProperty('aspectRatio');
    expect(body.response_done_timeout).toBe(2);
    expect(body).not.toHaveProperty('responseDoneTimeout');
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
        startAgent(livekitUrl: string, livekitToken: string): Promise<void>;
      }
    ).startAgent('wss://livekit.example.com', 'livekit-token');

    const requestInit = mockFetch.mock.calls[0]?.[1];
    const body = JSON.parse(String(requestInit?.body));

    expect(body).toEqual({
      transport_type: 'livekit',
      properties: {
        livekit_url: 'wss://livekit.example.com',
        livekit_token: 'livekit-token',
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
        startAgent(livekitUrl: string, livekitToken: string): Promise<string>;
      },
      'startAgent',
    ).mockResolvedValue('test-session-id');

    const remoteParticipant = {
      identity: 'lemonslice-avatar-agent',
      trackPublications: new Map([['video', { kind: TrackKind.KIND_VIDEO }]]),
    };
    const room = {
      name: 'test-room',
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

  it('leaveMeeting stops local relays before the remote API call and clears state when it rejects', async () => {
    vi.spyOn(voice.AvatarSession.prototype, 'start').mockResolvedValue(undefined);

    const avatar = new AvatarSession({
      apiKey: 'test-api-key',
      agentImageUrl: 'https://example.com/avatar.png',
    });
    vi.spyOn(
      avatar as unknown as {
        startAgent(livekitUrl: string, livekitToken: string): Promise<string>;
      },
      'startAgent',
    ).mockResolvedValue('test-session-id');

    const remoteParticipant = {
      identity: 'lemonslice-avatar-agent',
      trackPublications: new Map([['video', { kind: TrackKind.KIND_VIDEO }]]),
    };
    const room = {
      name: 'test-room',
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
      agentState: 'listening',
      interrupt: vi.fn(),
      generateReply: vi.fn(),
      output: { audio: null },
      input: { audio: null },
    } as unknown as voice.AgentSession;

    await avatar.start(agentSession, room as unknown as Room, {
      livekitUrl: 'wss://livekit.example.com',
      livekitApiKey: 'livekit-api-key',
      livekitApiSecret: 'livekit-api-secret',
    });

    const internals = avatar as unknown as {
      meetingBotId: string | null;
      meetingAudio: MeetingAudioInput | null;
      meetingChat: MeetingChatRelay | null;
      meetingRelayAbort: AbortController | null;
      meetingRelayTask: Promise<void> | null;
      callLeaveMeeting(sessionId: string, meetingBotId: string): Promise<void>;
    };

    // simulate an active joined meeting: audio input attached, chat relay draining,
    // and a relay task that only completes once its abort signal fires
    const meetingAudio = new MeetingAudioInput();
    const meetingChat = new MeetingChatRelay(agentSession);
    meetingChat.start();
    meetingChat.submitJson(JSON.stringify({ type: 'chat', sender: 'Alice', text: 'hello' }));

    const relayAbort = new AbortController();
    const relayTask = new Promise<void>((resolve) => {
      relayAbort.signal.addEventListener('abort', () => resolve(), { once: true });
    });

    internals.meetingBotId = 'bot-1';
    internals.meetingAudio = meetingAudio;
    internals.meetingChat = meetingChat;
    internals.meetingRelayAbort = relayAbort;
    internals.meetingRelayTask = relayTask;
    agentSession.input.audio = meetingAudio;

    const observed: { inputAudio?: unknown; relayAborted?: boolean; chatClosed?: boolean } = {};
    const leaveSpy = vi.spyOn(internals, 'callLeaveMeeting').mockImplementation(async () => {
      observed.inputAudio = agentSession.input.audio;
      observed.relayAborted = relayAbort.signal.aborted;
      observed.chatClosed = (meetingChat as unknown as { closed: boolean }).closed;
      throw new Error('remote leave rejected');
    });

    await avatar.leaveMeeting();

    // local meeting activity must be stopped before the remote leave API is awaited
    expect(leaveSpy).toHaveBeenCalledTimes(1);
    expect(observed.relayAborted).toBe(true);
    expect(observed.chatClosed).toBe(true);
    expect(observed.inputAudio).toBeNull();

    // local state is cleared even though the remote leave rejected
    expect(internals.meetingBotId).toBeNull();
    expect(internals.meetingAudio).toBeNull();
    expect(internals.meetingChat).toBeNull();
    expect(internals.meetingRelayAbort).toBeNull();
    expect(internals.meetingRelayTask).toBeNull();

    // a second call is a no-op
    await avatar.leaveMeeting();
    expect(leaveSpy).toHaveBeenCalledTimes(1);
  });
});
