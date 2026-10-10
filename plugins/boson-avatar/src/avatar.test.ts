// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { type JobContext, runWithJobContextAsync, voice } from '@livekit/agents';
import type { Room } from '@livekit/rtc-node';
import { TrackKind } from '@livekit/rtc-node';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type AvatarSessionInfo, AvatarSessionStartError, BosonAvatarAPI } from './api.js';
import { AvatarSession, MAX_DURATION_MS, SAMPLE_RATE } from './avatar.js';
import { BosonAvatarException } from './errors.js';

type FakeOutput = {
  audio: voice.AudioOutput | null;
  replaced: voice.AudioOutput | null;
  replaceAudioTail(audio: voice.AudioOutput): Promise<void>;
};

function fakeRoom(identity = 'voice-1'): Room {
  return {
    name: 'room-1',
    isConnected: true,
    localParticipant: { identity, registerRpcMethod: vi.fn() },
    on: vi.fn(),
    off: vi.fn(),
    remoteParticipants: new Map(),
  } as unknown as Room;
}

function fakeAgentSession(): voice.AgentSession & { output: FakeOutput; emitClose(): void } {
  const emitter = new EventEmitter();
  const output: FakeOutput = {
    audio: null,
    replaced: null,
    async replaceAudioTail(audio) {
      this.replaced = audio;
    },
  };
  return {
    output,
    on: vi.fn((event: string, callback: () => void) => emitter.on(event, callback)),
    off: vi.fn((event: string, callback: () => void) => emitter.off(event, callback)),
    emitClose: () => emitter.emit(voice.AgentSessionEventTypes.Close, {}),
  } as unknown as voice.AgentSession & { output: FakeOutput; emitClose(): void };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function decodeJwt(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()) as Record<
    string,
    unknown
  >;
}

describe('Boson AvatarSession', () => {
  beforeEach(() => {
    vi.stubEnv('BOSON_AVATAR_API_URL', 'https://avatar.test/v1');
    vi.stubEnv('BOSON_API_KEY', '');
    vi.stubEnv('BOSON_AVATAR_ID', '');
    vi.stubEnv('LIVEKIT_URL', '');
    vi.stubEnv('LIVEKIT_API_KEY', '');
    vi.stubEnv('LIVEKIT_API_SECRET', '');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    voice.DataStreamAudioOutput._playbackFinishedRpcRegistered = false;
    voice.DataStreamAudioOutput._playbackFinishedHandlers = {};
    voice.DataStreamAudioOutput._playbackStartedRpcRegistered = false;
    voice.DataStreamAudioOutput._playbackStartedHandlers = {};
  });

  it('constructor requires developer configuration', () => {
    expect(() => new AvatarSession({ apiKey: 'boson-key' })).toThrow(/avatarId/);
    expect(() => new AvatarSession({ avatarId: 'asset-1' })).toThrow(/BOSON_API_KEY/);
    vi.stubEnv('BOSON_AVATAR_API_URL', '');
    expect(() => new AvatarSession({ avatarId: 'asset-1', apiKey: 'boson-key' })).toThrow(
      /BOSON_AVATAR_API_URL/,
    );
  });

  it('constructor validates configuration', () => {
    const invalid: Array<Record<string, unknown>> = [
      { width: 640 },
      { width: 0, height: 640 },
      { width: true, height: 640 },
      { width: 1.5, height: 640 },
      { width: 'wide', height: 640 },
      { maxDurationMs: -1000 },
      { maxDurationMs: 1500 },
      { maxDurationMs: MAX_DURATION_MS + 1000 },
      { idempotencyKey: '' },
      { idempotencyKey: 123 },
      { idempotencyKey: 'application-session-1' },
    ];
    for (const options of invalid) {
      expect(
        () =>
          new AvatarSession({
            avatarId: 'asset-1',
            apiKey: 'boson-key',
            ...(options as object),
          }),
      ).toThrow(BosonAvatarException);
    }
  });

  it('constructor uses environment', () => {
    vi.stubEnv('BOSON_API_KEY', 'env-key');
    vi.stubEnv('BOSON_AVATAR_ID', 'asset-env');
    const session = new AvatarSession();
    expect(session.avatarIdentity).toBe('boson-avatar-agent');
  });

  it('start accepts generic agent audio and mints scoped token', async () => {
    vi.spyOn(voice.AvatarSession.prototype, 'start').mockResolvedValue(undefined);
    vi.spyOn(voice.AvatarSession.prototype, 'aclose').mockResolvedValue(undefined);
    const startSession = vi
      .spyOn(BosonAvatarAPI.prototype, 'startSession')
      .mockResolvedValue({ id: 'provider-session-1', avatarIdentity: 'avatar-1' });
    vi.spyOn(BosonAvatarAPI.prototype, 'endSession').mockResolvedValue(undefined);
    const agentSession = fakeAgentSession();
    const avatar = new AvatarSession({
      avatarId: 'asset-1',
      apiKey: 'boson-key',
      width: 640,
      height: 480,
      maxDurationMs: 900_000,
      avatarParticipantIdentity: 'avatar-1',
      avatarParticipantName: 'Demo Avatar',
    });
    const context = {
      job: { id: 'AJ_test' },
      agent: { identity: 'voice-1' },
    } as unknown as JobContext;
    await expect(
      runWithJobContextAsync(context, () =>
        avatar.start(agentSession, fakeRoom(), {
          livekitUrl: 'wss://tenant.livekit.cloud',
          livekitApiKey: 'livekit-key',
          livekitApiSecret: 'livekit-secret-with-enough-entropy',
        }),
      ),
    ).resolves.toBe('provider-session-1');
    expect(avatar.sessionId).toBe('provider-session-1');
    expect(agentSession.output.replaced).toBeInstanceOf(voice.DataStreamAudioOutput);
    expect(agentSession.output.replaced).toMatchObject({
      sampleRate: SAMPLE_RATE,
      destinationIdentity: 'avatar-1',
      waitRemoteTrack: TrackKind.KIND_AUDIO,
    });
    const call = startSession.mock.calls[0]![0];
    expect(call).toMatchObject({
      avatarId: 'asset-1',
      publisherIdentity: 'voice-1',
      width: 640,
      height: 480,
      maxDurationMs: 900_000,
      idempotencyKey: 'd2efd9c4-b705-5e73-9303-66ecad5bc551',
    });
    const claims = decodeJwt(call.livekitToken);
    expect(claims).toMatchObject({ sub: 'avatar-1', name: 'Demo Avatar', kind: 'agent' });
    expect(claims.video).toMatchObject({
      room: 'room-1',
      roomJoin: true,
      canSubscribe: false,
      canPublishData: true,
      canPublishSources: expect.arrayContaining(['camera', 'microphone']),
    });
    expect(claims.attributes).toMatchObject({ 'lk.publish_on_behalf': 'voice-1' });
    await expect(avatar.start(agentSession, fakeRoom())).rejects.toThrow(/called twice/);
  });

  it('start rejects avatar identity matching the agent', async () => {
    for (const [avatarIdentity, localIdentity, jobIdentity] of [
      ['voice-1', 'voice-1', null],
      [null, 'boson-avatar-agent', null],
      ['job-voice', 'voice-1', 'job-voice'],
    ] as const) {
      const baseStart = vi
        .spyOn(voice.AvatarSession.prototype, 'start')
        .mockResolvedValue(undefined);
      const apiStart = vi.spyOn(BosonAvatarAPI.prototype, 'startSession');
      const agentSession = fakeAgentSession();
      const avatar = new AvatarSession({
        avatarId: 'asset-1',
        apiKey: 'boson-key',
        avatarParticipantIdentity: avatarIdentity,
      });
      const start = () =>
        avatar.start(agentSession, fakeRoom(localIdentity), {
          livekitUrl: 'wss://tenant.livekit.cloud',
          livekitApiKey: 'livekit-key',
          livekitApiSecret: 'livekit-secret-with-enough-entropy',
        });
      const result = jobIdentity
        ? runWithJobContextAsync(
            { agent: { identity: jobIdentity } } as unknown as JobContext,
            start,
          )
        : start();
      await expect(result).rejects.toThrow(/must differ/);
      expect(baseStart).not.toHaveBeenCalled();
      expect(apiStart).not.toHaveBeenCalled();
      expect(agentSession.output.replaced).toBeNull();
      expect(avatar.sessionId).toBeNull();
      vi.restoreAllMocks();
    }
  });

  it('explicit idempotency key overrides LiveKit job default', async () => {
    vi.spyOn(voice.AvatarSession.prototype, 'start').mockResolvedValue(undefined);
    const startSession = vi
      .spyOn(BosonAvatarAPI.prototype, 'startSession')
      .mockResolvedValue({ id: 'provider-session-1', avatarIdentity: 'avatar-1' });
    const avatar = new AvatarSession({
      avatarId: 'asset-1',
      apiKey: 'boson-key',
      avatarParticipantIdentity: 'avatar-1',
      idempotencyKey: '123e4567-e89b-12d3-a456-426614174000',
    });
    await avatar.start(fakeAgentSession(), fakeRoom(), {
      livekitUrl: 'wss://tenant.livekit.cloud',
      livekitApiKey: 'livekit-key',
      livekitApiSecret: 'livekit-secret-with-enough-entropy',
    });
    expect(startSession.mock.calls[0]![0].idempotencyKey).toBe(
      '123e4567-e89b-12d3-a456-426614174000',
    );
  });

  it('start failure ends provider session and base session', async () => {
    vi.spyOn(voice.AvatarSession.prototype, 'start').mockResolvedValue(undefined);
    const baseClose = vi
      .spyOn(voice.AvatarSession.prototype, 'aclose')
      .mockResolvedValue(undefined);
    vi.spyOn(BosonAvatarAPI.prototype, 'startSession').mockResolvedValue({
      id: 'provider-session-1',
      avatarIdentity: 'avatar-1',
    });
    const endSession = vi
      .spyOn(BosonAvatarAPI.prototype, 'endSession')
      .mockResolvedValue(undefined);
    const agentSession = fakeAgentSession();
    agentSession.output.replaceAudioTail = async () => {
      throw new Error('sink rejected');
    };
    const avatar = configuredAvatar();
    await expect(startAvatar(avatar, agentSession)).rejects.toThrow('sink rejected');
    expect(endSession).toHaveBeenCalledOnce();
    expect(avatar.sessionId).toBeNull();
    await avatar.aclose();
    expect(endSession).toHaveBeenCalledOnce();
    expect(baseClose).toHaveBeenCalledOnce();
    expect(avatar.sessionId).toBeNull();
  });

  it('invalid start response retains session for cleanup retry', async () => {
    vi.spyOn(voice.AvatarSession.prototype, 'start').mockResolvedValue(undefined);
    const baseClose = vi
      .spyOn(voice.AvatarSession.prototype, 'aclose')
      .mockResolvedValue(undefined);
    const info = { id: 'provider-session-1', avatarIdentity: 'avatar-1' };
    vi.spyOn(BosonAvatarAPI.prototype, 'startSession').mockRejectedValue(
      new AvatarSessionStartError('invalid active session', info),
    );
    const endSession = vi
      .spyOn(BosonAvatarAPI.prototype, 'endSession')
      .mockRejectedValueOnce(new Error('delete failed'))
      .mockResolvedValue(undefined);
    const avatar = configuredAvatar();
    await expect(startAvatar(avatar)).rejects.toBeInstanceOf(AvatarSessionStartError);
    expect(avatar.sessionId).toBe('provider-session-1');
    await avatar.aclose();
    expect(endSession).toHaveBeenCalledTimes(2);
    expect(baseClose).toHaveBeenCalledOnce();
    expect(avatar.sessionId).toBeNull();
  });

  it('close retries API error and base cleanup remains idempotent', async () => {
    vi.spyOn(voice.AvatarSession.prototype, 'start').mockResolvedValue(undefined);
    const baseClose = vi
      .spyOn(voice.AvatarSession.prototype, 'aclose')
      .mockResolvedValue(undefined);
    vi.spyOn(BosonAvatarAPI.prototype, 'startSession').mockResolvedValue({
      id: 'provider-session-1',
      avatarIdentity: 'avatar-1',
    });
    const endSession = vi
      .spyOn(BosonAvatarAPI.prototype, 'endSession')
      .mockRejectedValueOnce(new Error('private-provider-response'))
      .mockResolvedValue(undefined);
    const avatar = configuredAvatar();
    await startAvatar(avatar);
    await Promise.all([avatar.aclose(), avatar.aclose()]);
    await avatar.aclose();
    expect(endSession).toHaveBeenCalledTimes(2);
    expect(baseClose).toHaveBeenCalledOnce();
    expect(avatar.sessionId).toBeNull();
  });

  it('start compensation log does not expose provider error', async () => {
    vi.spyOn(voice.AvatarSession.prototype, 'start').mockResolvedValue(undefined);
    vi.spyOn(voice.AvatarSession.prototype, 'aclose').mockResolvedValue(undefined);
    vi.spyOn(BosonAvatarAPI.prototype, 'startSession').mockResolvedValue({
      id: 'provider-session-1',
      avatarIdentity: 'avatar-1',
    });
    vi.spyOn(BosonAvatarAPI.prototype, 'endSession').mockRejectedValue(
      new Error('private-provider-response'),
    );
    const agentSession = fakeAgentSession();
    agentSession.output.replaceAudioTail = async () => {
      throw new Error('sink rejected');
    };
    const error = await startAvatar(configuredAvatar(), agentSession).catch(
      (value: unknown) => value,
    );
    expect(String(error)).toBe('Error: sink rejected');
    expect(String(error)).not.toContain('private-provider-response');
  });

  it('background cleanup does not expose provider error', async () => {
    vi.spyOn(voice.AvatarSession.prototype, 'start').mockResolvedValue(undefined);
    vi.spyOn(voice.AvatarSession.prototype, 'aclose').mockResolvedValue(undefined);
    vi.spyOn(BosonAvatarAPI.prototype, 'startSession').mockResolvedValue({
      id: 'provider-session-1',
      avatarIdentity: 'avatar-1',
    });
    vi.spyOn(BosonAvatarAPI.prototype, 'endSession').mockRejectedValue(
      new Error('private-provider-response'),
    );
    const avatar = configuredAvatar();
    const agentSession = fakeAgentSession();
    await startAvatar(avatar, agentSession);
    agentSession.emitClose();
    await Promise.resolve();
    expect(avatar.sessionId).toBe('provider-session-1');
  });

  it('close waits for inflight start and compensates session', async () => {
    vi.spyOn(voice.AvatarSession.prototype, 'start').mockResolvedValue(undefined);
    const baseClose = vi
      .spyOn(voice.AvatarSession.prototype, 'aclose')
      .mockResolvedValue(undefined);
    const creation = deferred<AvatarSessionInfo>();
    vi.spyOn(BosonAvatarAPI.prototype, 'startSession').mockReturnValue(creation.promise);
    const endSession = vi
      .spyOn(BosonAvatarAPI.prototype, 'endSession')
      .mockResolvedValue(undefined);
    const avatar = configuredAvatar();
    const start = startAvatar(avatar);
    await vi.waitFor(() => expect(BosonAvatarAPI.prototype.startSession).toHaveBeenCalledOnce());
    const close = avatar.aclose();
    creation.resolve({ id: 'provider-session-1', avatarIdentity: 'avatar-1' });
    await expect(start).rejects.toThrow(/closed while start/);
    await close;
    expect(endSession).toHaveBeenCalledWith('provider-session-1');
    expect(baseClose).toHaveBeenCalledOnce();
    expect(avatar.sessionId).toBeNull();
  });

  it('close handles completed startup cleanup before its callback', async () => {
    for (const retryDelete of [false, true]) {
      vi.spyOn(voice.AvatarSession.prototype, 'start').mockResolvedValue(undefined);
      const baseClose = vi
        .spyOn(voice.AvatarSession.prototype, 'aclose')
        .mockResolvedValue(undefined);
      vi.spyOn(BosonAvatarAPI.prototype, 'startSession').mockRejectedValue(
        new AvatarSessionStartError('invalid', {
          id: 'provider-session-1',
          avatarIdentity: 'avatar-1',
        }),
      );
      const endSession = vi.spyOn(BosonAvatarAPI.prototype, 'endSession');
      if (retryDelete) {
        endSession.mockRejectedValueOnce(new Error('delete failed')).mockResolvedValue(undefined);
      } else {
        endSession.mockResolvedValue(undefined);
      }
      const avatar = configuredAvatar();
      await expect(startAvatar(avatar)).rejects.toThrow('invalid');
      await avatar.aclose();
      await avatar.aclose();
      expect(endSession).toHaveBeenCalledTimes(retryDelete ? 2 : 1);
      expect(baseClose).toHaveBeenCalledOnce();
      expect(avatar.sessionId).toBeNull();
      vi.restoreAllMocks();
    }
  });

  it('concurrent start cleanup keeps the owned create and delete promises alive', async () => {
    vi.spyOn(voice.AvatarSession.prototype, 'start').mockResolvedValue(undefined);
    const baseClose = vi
      .spyOn(voice.AvatarSession.prototype, 'aclose')
      .mockResolvedValue(undefined);
    const creation = deferred<AvatarSessionInfo>();
    const deletion = deferred<void>();
    vi.spyOn(BosonAvatarAPI.prototype, 'startSession').mockReturnValue(creation.promise);
    const endSession = vi
      .spyOn(BosonAvatarAPI.prototype, 'endSession')
      .mockReturnValue(deletion.promise);
    const avatar = configuredAvatar();
    const start = startAvatar(avatar);
    await vi.waitFor(() => expect(BosonAvatarAPI.prototype.startSession).toHaveBeenCalledOnce());
    const close1 = avatar.aclose();
    const close2 = avatar.aclose();
    creation.resolve({ id: 'provider-session-1', avatarIdentity: 'avatar-1' });
    deletion.resolve();
    await expect(start).rejects.toThrow(/closed while start/);
    await Promise.all([close1, close2]);
    expect(endSession).toHaveBeenCalledOnce();
    expect(baseClose).toHaveBeenCalledOnce();
  });

  it('a detached start caller still waits for create and compensates the session', async () => {
    vi.spyOn(voice.AvatarSession.prototype, 'start').mockResolvedValue(undefined);
    const baseClose = vi
      .spyOn(voice.AvatarSession.prototype, 'aclose')
      .mockResolvedValue(undefined);
    const creation = deferred<AvatarSessionInfo>();
    vi.spyOn(BosonAvatarAPI.prototype, 'startSession').mockReturnValue(creation.promise);
    const endSession = vi
      .spyOn(BosonAvatarAPI.prototype, 'endSession')
      .mockResolvedValue(undefined);
    const avatar = configuredAvatar();
    const start = startAvatar(avatar);
    await vi.waitFor(() => expect(BosonAvatarAPI.prototype.startSession).toHaveBeenCalledOnce());
    const close = avatar.aclose();
    creation.resolve({ id: 'provider-session-1', avatarIdentity: 'avatar-1' });
    await close;
    await expect(start).rejects.toThrow(/closed while start/);
    expect(endSession).toHaveBeenCalledOnce();
    expect(baseClose).toHaveBeenCalledOnce();
  });

  it('concurrent close during startup compensation does not duplicate or cancel delete', async () => {
    vi.spyOn(voice.AvatarSession.prototype, 'start').mockResolvedValue(undefined);
    const baseClose = vi
      .spyOn(voice.AvatarSession.prototype, 'aclose')
      .mockResolvedValue(undefined);
    vi.spyOn(BosonAvatarAPI.prototype, 'startSession').mockResolvedValue({
      id: 'provider-session-1',
      avatarIdentity: 'avatar-1',
    });
    const deletion = deferred<void>();
    const endSession = vi
      .spyOn(BosonAvatarAPI.prototype, 'endSession')
      .mockReturnValue(deletion.promise);
    const agentSession = fakeAgentSession();
    agentSession.output.replaceAudioTail = async () => {
      throw new Error('sink rejected');
    };
    const avatar = configuredAvatar();
    const start = startAvatar(avatar, agentSession);
    await vi.waitFor(() => expect(endSession).toHaveBeenCalledOnce());
    const close = avatar.aclose();
    deletion.resolve();
    await expect(start).rejects.toThrow('sink rejected');
    await close;
    expect(endSession).toHaveBeenCalledOnce();
    expect(baseClose).toHaveBeenCalledOnce();
    expect(avatar.sessionId).toBeNull();
  });

  it('cancelling close equivalent does not cancel owned delete', async () => {
    vi.spyOn(voice.AvatarSession.prototype, 'start').mockResolvedValue(undefined);
    vi.spyOn(voice.AvatarSession.prototype, 'aclose').mockResolvedValue(undefined);
    vi.spyOn(BosonAvatarAPI.prototype, 'startSession').mockResolvedValue({
      id: 'provider-session-1',
      avatarIdentity: 'avatar-1',
    });
    const deletion = deferred<void>();
    const endSession = vi
      .spyOn(BosonAvatarAPI.prototype, 'endSession')
      .mockReturnValue(deletion.promise);
    const avatar = configuredAvatar();
    await startAvatar(avatar);
    void avatar.aclose();
    deletion.resolve();
    await avatar.aclose();
    expect(endSession).toHaveBeenCalledOnce();
    expect(avatar.sessionId).toBeNull();
  });

  it('AgentSession Close event ends provider session', async () => {
    vi.spyOn(voice.AvatarSession.prototype, 'start').mockResolvedValue(undefined);
    const baseClose = vi
      .spyOn(voice.AvatarSession.prototype, 'aclose')
      .mockResolvedValue(undefined);
    vi.spyOn(BosonAvatarAPI.prototype, 'startSession').mockResolvedValue({
      id: 'provider-session-1',
      avatarIdentity: 'avatar-1',
    });
    const endSession = vi
      .spyOn(BosonAvatarAPI.prototype, 'endSession')
      .mockResolvedValue(undefined);
    const avatar = configuredAvatar();
    const agentSession = fakeAgentSession();
    await startAvatar(avatar, agentSession);
    agentSession.emitClose();
    await vi.waitFor(() => expect(avatar.sessionId).toBeNull());
    expect(endSession).toHaveBeenCalledWith('provider-session-1');
    expect(baseClose).toHaveBeenCalledOnce();
  });
});

function configuredAvatar(): AvatarSession {
  return new AvatarSession({
    avatarId: 'asset-1',
    apiKey: 'boson-key',
    avatarParticipantIdentity: 'avatar-1',
  });
}

function startAvatar(avatar: AvatarSession, agentSession = fakeAgentSession()): Promise<string> {
  return avatar.start(agentSession, fakeRoom(), {
    livekitUrl: 'wss://tenant.livekit.cloud',
    livekitApiKey: 'livekit-key',
    livekitApiSecret: 'livekit-secret-with-enough-entropy',
  });
}
