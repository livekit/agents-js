// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { voice } from '@livekit/agents';
import type { Room } from '@livekit/rtc-node';
import { TrackKind } from '@livekit/rtc-node';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnamAPI } from './api.js';
import { AvatarSession } from './avatar.js';
import { AnamException, type PersonaConfig } from './types.js';

const LIVEKIT = {
  livekitUrl: 'wss://example.livekit.cloud',
  livekitApiKey: 'test-key',
  livekitApiSecret: 'test-secret-long-enough-for-hs256-signing',
};
const PERSONA: PersonaConfig = { name: 'test', avatarId: 'avatar-id' };

type DataStreamAudioOutputInternals = {
  destinationIdentity: string;
  sampleRate: number;
  waitRemoteTrack?: TrackKind;
  waitPlaybackStart: boolean;
  clearBufferTimeout?: number;
};

function fakeRoom(): Room {
  return {
    name: 'room',
    isConnected: false,
    localParticipant: { identity: 'agent' },
    on: vi.fn(),
  } as unknown as Room;
}

function fakeAgentSession(): voice.AgentSession {
  return {
    _started: false,
    output: { audio: null },
  } as unknown as voice.AgentSession;
}

function decodeJwt(token: string) {
  return JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()) as {
    sub: string;
    kind: string;
    video: { roomJoin: boolean; room: string };
    attributes: Record<string, string>;
  };
}

describe('Anam AvatarSession', () => {
  beforeEach(() => {
    vi.spyOn(voice.AvatarSession.prototype, 'start').mockResolvedValue(undefined);
    vi.spyOn(AnamAPI.prototype, 'startSession').mockResolvedValue({ sessionId: 'session-1' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.ANAM_API_KEY;
    delete process.env.LIVEKIT_URL;
    delete process.env.LIVEKIT_API_KEY;
    delete process.env.LIVEKIT_API_SECRET;
  });

  it('calls base AvatarSession.start first', async () => {
    const sentinel = new Error('super-start-called');
    const superStartSpy = vi
      .mocked(voice.AvatarSession.prototype.start)
      .mockRejectedValue(sentinel);

    const avatar = new AvatarSession({
      apiKey: 'anam-key',
      personaConfig: {
        personaId: 'persona-test',
      },
    });

    await expect(avatar.start(fakeAgentSession(), {} as unknown as Room)).rejects.toThrow(
      'super-start-called',
    );
    expect(superStartSpy).toHaveBeenCalledTimes(1);
  });

  it('waits for playback started', async () => {
    const avatar = new AvatarSession({ personaConfig: PERSONA, apiKey: 'anam-key' });
    const agentSession = fakeAgentSession();
    await avatar.start(agentSession, fakeRoom(), LIVEKIT);

    const output = agentSession.output.audio as unknown as DataStreamAudioOutputInternals;
    expect(output).toBeInstanceOf(voice.DataStreamAudioOutput);
    expect(output.waitPlaybackStart).toBe(true);
    expect(output.destinationIdentity).toBe('anam-avatar-agent');
    expect(output.sampleRate).toBe(24000);
    expect(output.waitRemoteTrack).toBe(TrackKind.KIND_VIDEO);
    expect(output).not.toHaveProperty('clearBufferTimeout');
    expect((avatar as unknown as { sessionId?: string }).sessionId).toBe('session-1');
  });

  it('sends the avatar to a custom identity', async () => {
    const avatar = new AvatarSession({
      personaConfig: PERSONA,
      apiKey: 'anam-key',
      avatarParticipantIdentity: 'my-avatar',
    });
    const agentSession = fakeAgentSession();
    await avatar.start(agentSession, fakeRoom(), LIVEKIT);

    const output = agentSession.output.audio as unknown as DataStreamAudioOutputInternals;
    expect(output.destinationIdentity).toBe('my-avatar');
    expect(avatar.avatarIdentity).toBe('my-avatar');
  });

  it('mints a publish-on-behalf token', async () => {
    const avatar = new AvatarSession({ personaConfig: PERSONA, apiKey: 'anam-key' });
    await avatar.start(fakeAgentSession(), fakeRoom(), LIVEKIT);

    const request = vi.mocked(AnamAPI.prototype.startSession).mock.calls[0]![0];
    expect(request.personaConfig).toBe(PERSONA);
    expect(request.livekitUrl).toBe(LIVEKIT.livekitUrl);
    const claims = decodeJwt(request.livekitToken!);
    expect(claims).toMatchObject({
      sub: 'anam-avatar-agent',
      kind: 'agent',
      video: { roomJoin: true, room: 'room' },
      attributes: { 'lk.publish_on_behalf': 'agent' },
    });
  });

  it('requires an API key', () => {
    expect(() => new AvatarSession({ personaConfig: PERSONA })).toThrow(AnamException);
  });

  it('requires LiveKit credentials before configuring audio output', async () => {
    const avatar = new AvatarSession({ personaConfig: PERSONA, apiKey: 'anam-key' });
    const agentSession = fakeAgentSession();

    await expect(avatar.start(agentSession, fakeRoom())).rejects.toThrow(AnamException);
    expect(agentSession.output.audio).toBeNull();
  });
});
