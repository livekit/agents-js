// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { voice } from '@livekit/agents';
import type { Room } from '@livekit/rtc-node';
import { RoomEvent, TrackKind } from '@livekit/rtc-node';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SynthesiaAPI } from './api.js';
import { AvatarSession } from './avatar.js';
import { ErrorType, SynthesiaError } from './errors.js';
import * as logModule from './log.js';
import { AVATAR_IDENTITY, AVATAR_NAME, AvatarConfig } from './types.js';

const LIVEKIT = {
  livekitUrl: 'wss://dev.livekit.cloud',
  livekitApiKey: 'lk-api-key',
  livekitApiSecret: 'lk-api-secret-never-leaks',
};
const ADA_ID = '03cee7ec-ac90-45ec-8c20-74a399cf3dc4';
const SECOND_ID = '6d999451-039c-4bf2-9b88-c769ac2faa78';

type RpcOptions = {
  destinationIdentity: string;
  method: string;
  payload: string;
  responseTimeout?: number;
};

function fakeRoom({ identity = 'dev-agent', connected = true } = {}) {
  const emitter = new EventEmitter();
  const rpcCalls: RpcOptions[] = [];
  let rpcResponse = JSON.stringify({ status: 'ok', avatar_id: SECOND_ID });
  let rpcError: unknown;
  const remoteParticipant = {
    identity: AVATAR_IDENTITY,
    trackPublications: new Map([['video', { kind: TrackKind.KIND_VIDEO }]]),
  };
  const room = {
    name: 'dev-room',
    isConnected: connected,
    localParticipant: {
      identity,
      registerRpcMethod: vi.fn(),
      performRpc: vi.fn(async (options: RpcOptions) => {
        rpcCalls.push(options);
        if (rpcError) throw rpcError;
        return rpcResponse;
      }),
    },
    remoteParticipants: new Map([[remoteParticipant.identity, remoteParticipant]]),
    on: vi.fn((event: string | symbol, listener: (...args: unknown[]) => void) => {
      emitter.on(event, listener);
      return room;
    }),
    off: vi.fn((event: string | symbol, listener: (...args: unknown[]) => void) => {
      emitter.off(event, listener);
      return room;
    }),
    emit: (event: string | symbol, ...args: unknown[]) => emitter.emit(event, ...args),
    listenerCount: (event: string | symbol) => emitter.listenerCount(event),
  } as unknown as Room;
  return {
    room,
    rpcCalls,
    emit(event: string | symbol, ...args: unknown[]) {
      emitter.emit(event, ...args);
    },
    setRpcResponse(value: string) {
      rpcResponse = value;
    },
    setRpcError(value: unknown) {
      rpcError = value;
    },
  };
}

function fakeAgentSession() {
  const emitter = new EventEmitter();
  const output = {
    audio: null as voice.AudioOutput | null,
    replaceAudioTail(sink: voice.AudioOutput) {
      this.audio = sink;
    },
  };
  const session = {
    _started: false,
    output,
    on: vi.fn((event: string | symbol, listener: (...args: unknown[]) => void) => {
      emitter.on(event, listener);
      return session;
    }),
    off: vi.fn((event: string | symbol, listener: (...args: unknown[]) => void) => {
      emitter.off(event, listener);
      return session;
    }),
    emit: vi.fn(),
  } as unknown as voice.AgentSession;
  return session;
}

function avatar(options: ConstructorParameters<typeof AvatarSession>[1] = {}) {
  return new AvatarSession(new AvatarConfig({ avatarIds: [ADA_ID, SECOND_ID] }), {
    apiKey: 'syn-key',
    ...options,
  });
}

function decodeJwt(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()) as Record<
    string,
    unknown
  >;
}

describe('Synthesia AvatarSession', () => {
  beforeEach(() => {
    vi.spyOn(SynthesiaAPI.prototype, 'startSession').mockResolvedValue({ sessionId: 'sess_123' });
    vi.spyOn(voice.AvatarSession.prototype, 'waitForJoin').mockResolvedValue();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.SYNTHESIA_API_KEY;
    delete process.env.SYNTHESIA_API_URL;
    delete process.env.LIVEKIT_URL;
    delete process.env.LIVEKIT_API_KEY;
    delete process.env.LIVEKIT_API_SECRET;
    voice.DataStreamAudioOutput._playbackFinishedRpcRegistered = false;
    voice.DataStreamAudioOutput._playbackFinishedHandlers = {};
    voice.DataStreamAudioOutput._playbackStartedRpcRegistered = false;
    voice.DataStreamAudioOutput._playbackStartedHandlers = {};
  });

  it('requires a key and accepts it from the environment', () => {
    expect(() => new AvatarSession(new AvatarConfig({ avatarIds: [ADA_ID] }))).toThrow(
      SynthesiaError,
    );
    process.env.SYNTHESIA_API_KEY = 'env-key';
    expect(() => new AvatarSession(new AvatarConfig({ avatarIds: [ADA_ID] }))).not.toThrow();
  });

  it('does not expose its API key when serialized', () => {
    expect(JSON.stringify(avatar({ apiKey: 'super-secret' }))).not.toContain('super-secret');
  });

  it.each([
    ['avatarParticipantIdentity', ''],
    ['avatarParticipantIdentity', '   '],
    ['avatarParticipantName', ''],
    ['avatarParticipantName', '   '],
  ] as const)('rejects blank %s', (key, value) => {
    expect(() => avatar({ [key]: value })).toThrow(key);
  });

  it('calls the base start before provisioning', async () => {
    const sentinel = new Error('super-start-called');
    vi.spyOn(voice.AvatarSession.prototype, 'start').mockRejectedValueOnce(sentinel);
    await expect(avatar().start(fakeAgentSession(), fakeRoom().room, LIVEKIT)).rejects.toThrow(
      sentinel,
    );
    expect(SynthesiaAPI.prototype.startSession).not.toHaveBeenCalled();
  });

  it('mints the expected worker token, provisions in order, and routes audio', async () => {
    const agent = fakeAgentSession();
    const { room } = fakeRoom();
    const session = avatar();
    await session.start(agent, room, LIVEKIT);

    const request = vi.mocked(SynthesiaAPI.prototype.startSession).mock.calls[0]![0];
    expect(request.avatarIds).toEqual([ADA_ID, SECOND_ID]);
    expect(request.livekitUrl).toBe(LIVEKIT.livekitUrl);
    const claims = decodeJwt(request.livekitToken) as {
      sub: string;
      name: string;
      kind: string;
      video: Record<string, unknown>;
      attributes: Record<string, string>;
      exp: number;
    };
    expect(claims).toMatchObject({
      sub: AVATAR_IDENTITY,
      name: AVATAR_NAME,
      kind: 'agent',
      video: {
        roomJoin: true,
        room: 'dev-room',
        canPublish: true,
        canSubscribe: true,
        canPublishData: true,
      },
      attributes: { 'lk.publish_on_behalf': 'dev-agent' },
    });
    expect(claims.exp).toBeGreaterThan(Math.floor(Date.now() / 1000) + 6 * 60 * 60 - 5);
    expect(session.sessionId).toBe('sess_123');
    expect(agent.output.audio).toBeInstanceOf(voice.DataStreamAudioOutput);
    expect(agent.output.audio).toMatchObject({
      destinationIdentity: AVATAR_IDENTITY,
      waitRemoteTrack: TrackKind.KIND_VIDEO,
    });
    await session.aclose();
  });

  it.each([
    ['https://proj.livekit.cloud', 'wss://proj.livekit.cloud'],
    ['http://localhost:7880', 'ws://localhost:7880'],
    ['wss://proj.livekit.cloud', 'wss://proj.livekit.cloud'],
    ['ws://localhost:7880', 'ws://localhost:7880'],
  ])('normalizes %s to %s', async (given, expected) => {
    const session = avatar();
    await session.start(fakeAgentSession(), fakeRoom().room, { ...LIVEKIT, livekitUrl: given });
    expect(vi.mocked(SynthesiaAPI.prototype.startSession).mock.calls[0]![0].livekitUrl).toBe(
      expected,
    );
    await session.aclose();
  });

  it.each(['host:7880', 'tcp://host:7880', 'proj.livekit.cloud'])(
    'rejects unusable URL %s',
    async (url) => {
      await expect(
        avatar().start(fakeAgentSession(), fakeRoom().room, { ...LIVEKIT, livekitUrl: url }),
      ).rejects.toThrow('livekitUrl');
      expect(SynthesiaAPI.prototype.startSession).not.toHaveBeenCalled();
    },
  );

  it.each([
    { livekitUrl: '', livekitApiKey: 'key', livekitApiSecret: 'secret' },
    { livekitUrl: 'wss://host', livekitApiKey: '   ', livekitApiSecret: 'secret' },
    { livekitUrl: 'wss://host', livekitApiKey: 'key', livekitApiSecret: '   ' },
  ])('rejects missing or blank LiveKit credentials before launch', async (options) => {
    await expect(avatar().start(fakeAgentSession(), fakeRoom().room, options)).rejects.toThrow(
      'LiveKit',
    );
    expect(SynthesiaAPI.prototype.startSession).not.toHaveBeenCalled();
  });

  it('uses LiveKit credentials from the environment', async () => {
    process.env.LIVEKIT_URL = LIVEKIT.livekitUrl;
    process.env.LIVEKIT_API_KEY = 'env-key';
    process.env.LIVEKIT_API_SECRET = 'env-secret';
    const session = avatar();
    await session.start(fakeAgentSession(), fakeRoom().room);
    const token = vi.mocked(SynthesiaAPI.prototype.startSession).mock.calls[0]![0].livekitToken;
    expect(decodeJwt(token).iss).toBe('env-key');
    await session.aclose();
  });

  it('fails before launch when the standalone room has no local identity', async () => {
    await expect(
      avatar().start(fakeAgentSession(), fakeRoom({ identity: '   ' }).room, LIVEKIT),
    ).rejects.toThrow('local participant');
    expect(SynthesiaAPI.prototype.startSession).not.toHaveBeenCalled();
  });

  it('supports custom participant identity and name everywhere', async () => {
    const session = avatar({
      avatarParticipantIdentity: 'avatar-host',
      avatarParticipantName: 'Host Avatar',
    });
    const room = fakeRoom();
    room.setRpcResponse(JSON.stringify({ status: 'ok', avatar_id: SECOND_ID }));
    const agent = fakeAgentSession();
    await session.start(agent, room.room, LIVEKIT);
    const token = vi.mocked(SynthesiaAPI.prototype.startSession).mock.calls[0]![0].livekitToken;
    expect(decodeJwt(token)).toMatchObject({ sub: 'avatar-host', name: 'Host Avatar' });
    expect(session.avatarIdentity).toBe('avatar-host');
    expect(agent.output.audio).toMatchObject({ destinationIdentity: 'avatar-host' });
    await expect(session.swapAvatar(SECOND_ID)).resolves.toBe(SECOND_ID);
    expect(room.rpcCalls[0]).toMatchObject({ destinationIdentity: 'avatar-host' });
    await session.aclose();
  });

  it('sends swap RPCs and supports default', async () => {
    const room = fakeRoom();
    const session = avatar();
    await session.start(fakeAgentSession(), room.room, LIVEKIT);
    await expect(session.swapAvatar(SECOND_ID)).resolves.toBe(SECOND_ID);
    expect(room.rpcCalls[0]).toEqual({
      destinationIdentity: AVATAR_IDENTITY,
      method: 'swapAvatar',
      payload: JSON.stringify({ avatar_id: SECOND_ID }),
      responseTimeout: 15_000,
    });
    room.setRpcResponse(JSON.stringify({ status: 'ok', avatar_id: ADA_ID }));
    await expect(session.swapAvatar('default')).resolves.toBe(ADA_ID);
    await session.aclose();
  });

  it('rejects swaps not precomputed without making an RPC', async () => {
    const room = fakeRoom();
    const session = avatar();
    await session.start(fakeAgentSession(), room.room, LIVEKIT);
    await expect(session.swapAvatar('not-in-list')).rejects.toMatchObject({
      type: ErrorType.UNKNOWN_AVATAR,
    });
    expect(room.rpcCalls).toHaveLength(0);
    await session.aclose();
  });

  it.each([
    ['worker error', JSON.stringify({ error: 'swap timeout' }), 'swap timeout'],
    ['unrecognized response', JSON.stringify({ status: 'weird' }), 'weird'],
    ['malformed response', 'not json', 'malformed'],
  ])('surfaces a %s', async (_case, raw, message) => {
    const room = fakeRoom();
    room.setRpcResponse(raw);
    const session = avatar();
    await session.start(fakeAgentSession(), room.room, LIVEKIT);
    await expect(session.swapAvatar(SECOND_ID)).rejects.toThrow(message);
    await session.aclose();
  });

  it('maps swap transport failures to connection errors', async () => {
    const room = fakeRoom();
    room.setRpcError(new Error('rpc transport down'));
    const session = avatar();
    await session.start(fakeAgentSession(), room.room, LIVEKIT);
    await expect(session.swapAvatar(SECOND_ID)).rejects.toMatchObject({
      type: ErrorType.CONNECTION,
    });
    await session.aclose();
  });

  it('rejects swaps before start and after close', async () => {
    const session = avatar();
    await expect(session.swapAvatar(SECOND_ID)).rejects.toThrow('started');
    await session.start(fakeAgentSession(), fakeRoom().room, LIVEKIT);
    await session.aclose();
    await expect(session.swapAvatar(SECOND_ID)).rejects.toThrow('started');
  });

  it('maps join timeout and tears down its exact audio output', async () => {
    vi.mocked(voice.AvatarSession.prototype.waitForJoin).mockRejectedValueOnce(
      new Error('timed out waiting for avatar participant'),
    );
    const close = vi.spyOn(voice.DataStreamAudioOutput.prototype, 'aclose');
    const session = avatar({ joinTimeout: 50 });
    await expect(session.start(fakeAgentSession(), fakeRoom().room, LIVEKIT)).rejects.toMatchObject(
      {
        type: ErrorType.TIMEOUT,
        message: 'avatar did not join within 50ms',
      },
    );
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('tears down after a mapped launch failure and can retry', async () => {
    vi.mocked(SynthesiaAPI.prototype.startSession)
      .mockRejectedValueOnce(new SynthesiaError('bad key', { type: ErrorType.AUTH }))
      .mockResolvedValueOnce({ sessionId: 'sess_retry' });
    const session = avatar();
    const room = fakeRoom();
    const agent = fakeAgentSession();
    await expect(session.start(agent, room.room, LIVEKIT)).rejects.toMatchObject({
      type: ErrorType.AUTH,
    });
    expect(agent.output.audio).toBeNull();
    await session.start(agent, room.room, LIVEKIT);
    expect(session.sessionId).toBe('sess_retry');
    await session.aclose();
  });

  it('is idempotent across double start and double close', async () => {
    const session = avatar();
    const room = fakeRoom();
    const agent = fakeAgentSession();
    await session.start(agent, room.room, LIVEKIT);
    await session.start(agent, room.room, LIVEKIT);
    expect(SynthesiaAPI.prototype.startSession).toHaveBeenCalledTimes(1);
    await session.aclose();
    await session.aclose();
  });

  it.each([
    ['track', RoomEvent.TrackUnpublished],
    ['participant', RoomEvent.ParticipantDisconnected],
  ])('logs an unexpected %s loss once and tears down', async (kind, event) => {
    const logger = logModule.log();
    const warn = vi.spyOn(logger, 'warn');
    vi.spyOn(logModule, 'log').mockReturnValue(logger);
    const close = vi.spyOn(voice.DataStreamAudioOutput.prototype, 'aclose');
    const room = fakeRoom();
    const session = avatar();
    await session.start(fakeAgentSession(), room.room, LIVEKIT);
    const participant = { identity: AVATAR_IDENTITY };
    if (event === RoomEvent.TrackUnpublished) {
      room.emit(event, { kind: TrackKind.KIND_VIDEO }, participant);
    } else {
      room.emit(event, participant);
    }
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    expect(warn).toHaveBeenCalledWith('avatar left the room unexpectedly');
    expect(kind).toBeTruthy();
  });

  it('logs a clean room end, tears down, and unregisters lifecycle handlers', async () => {
    const logger = logModule.log();
    const info = vi.spyOn(logger, 'info');
    vi.spyOn(logModule, 'log').mockReturnValue(logger);
    const room = fakeRoom();
    const session = avatar();
    await session.start(fakeAgentSession(), room.room, LIVEKIT);
    expect(room.room.listenerCount(RoomEvent.Disconnected)).toBeGreaterThan(0);
    room.emit(RoomEvent.Disconnected);
    await vi.waitFor(() => expect(room.room.listenerCount(RoomEvent.TrackUnpublished)).toBe(0));
    expect(info).toHaveBeenCalledWith('avatar session ended');
  });

  it('ignores another avatar identity disconnect', async () => {
    const logger = logModule.log();
    const warn = vi.spyOn(logger, 'warn');
    vi.spyOn(logModule, 'log').mockReturnValue(logger);
    const room = fakeRoom();
    const session = avatar({ avatarParticipantIdentity: 'avatar-host' });
    await session.start(fakeAgentSession(), room.room, LIVEKIT);
    room.emit(RoomEvent.ParticipantDisconnected, { identity: AVATAR_IDENTITY });
    expect(warn).not.toHaveBeenCalledWith('avatar left the room unexpectedly');
    await session.aclose();
  });

  it('mirrors the README attach-before-agent usage', async () => {
    process.env.SYNTHESIA_API_KEY = 'syn_live_key';
    process.env.LIVEKIT_URL = LIVEKIT.livekitUrl;
    process.env.LIVEKIT_API_KEY = LIVEKIT.livekitApiKey;
    process.env.LIVEKIT_API_SECRET = LIVEKIT.livekitApiSecret;
    const session = fakeAgentSession();
    const room = fakeRoom();
    const attachedAvatar = new AvatarSession(new AvatarConfig({ avatarIds: [ADA_ID] }));
    await attachedAvatar.start(session, room.room);
    expect(session.output.audio).not.toBeNull();
    expect(session.output.audio).toMatchObject({ destinationIdentity: AVATAR_IDENTITY });
    await attachedAvatar.aclose();
  });
});
