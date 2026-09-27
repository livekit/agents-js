// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Future, initializeLogger, voice } from '@livekit/agents';
import { AudioFrame, type Room, type RpcInvocationData } from '@livekit/rtc-node';
import type * as SpatiusSDK from '@spatius/server-sdk';
import {
  type AvatarSession as SDKSession,
  type SessionConfig,
  newAvatarSession,
} from '@spatius/server-sdk';
import { TokenVerifier } from 'livekit-server-sdk';
import { EventEmitter } from 'node:events';
import { ReadableStream } from 'node:stream/web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AvatarSession, type AvatarSessionOptions } from './avatar.js';

vi.mock('@spatius/server-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof SpatiusSDK>()),
  newAvatarSession: vi.fn(),
}));

initializeLogger({ pretty: false, level: 'silent' });
const credentials = { apiKey: 'spatius-test', appId: 'app-test', avatarId: 'avatar-test' };
const livekit = {
  livekitUrl: 'wss://livekit.example.com',
  livekitApiKey: 'test-key',
  livekitApiSecret: 'test-secret-with-at-least-thirty-two-characters',
};
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const frame = (sample = 123, rate = 24000) =>
  new AudioFrame(new Int16Array([sample, -sample]), rate, 1, 2);

describe('Spatius AvatarSession', () => {
  let config: SessionConfig;
  let sdk: ReturnType<typeof makeSDK>;
  let session: voice.AgentSession;
  let avatar: AvatarSession;
  let room: Room;
  let handlers: Map<string, (data: RpcInvocationData) => Promise<string>>;

  function makeSDK() {
    return {
      init: vi.fn(async () => {}),
      start: vi.fn(async () => 'connection-id'),
      sendAudio: vi.fn(async (_audio: Uint8Array, _end: boolean) => 'request-id'),
      interrupt: vi.fn(async () => 'request-id'),
      close: vi.fn(async () => {}),
    };
  }

  async function start(options: AvatarSessionOptions = {}) {
    avatar = new AvatarSession({ ...credentials, ...options });
    await avatar.start(session, room, livekit);
    return session.output.audio!;
  }

  function rpc(method: string, payload = '', callerIdentity = avatar.avatarIdentity) {
    return handlers.get(`lk.${method}`)!({ payload, callerIdentity } as RpcInvocationData);
  }

  beforeEach(() => {
    sdk = makeSDK();
    vi.mocked(newAvatarSession).mockImplementation((value) => {
      config = value;
      return sdk as unknown as SDKSession;
    });
    session = new voice.AgentSession({ vad: null, turnHandling: { turnDetection: null } });
    handlers = new Map();
    room = Object.assign(new EventEmitter(), {
      name: 'test-room',
      isConnected: false,
      localParticipant: {
        identity: 'test-agent',
        registerRpcMethod: vi.fn((method, handler) => handlers.set(method, handler)),
        unregisterRpcMethod: vi.fn((method) => handlers.delete(method)),
      },
    }) as unknown as Room;
  });

  afterEach(async () => {
    await avatar?.aclose();
    await session.close();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it('configures Opus, copies extra params, and mints a restricted agent token', async () => {
    const extraParams = { server_post_process: 'false' };
    avatar = new AvatarSession({
      ...credentials,
      extraParams,
      idleTimeout: 25000,
      avatarParticipantIdentity: 'custom-avatar',
      avatarParticipantName: 'Custom Avatar',
    });
    extraParams.server_post_process = 'true';
    await Promise.all([avatar.start(session, room, livekit), avatar.start(session, room, livekit)]);
    expect(newAvatarSession).toHaveBeenCalledOnce();
    expect(config).toMatchObject({
      ...credentials,
      sampleRate: 24000,
      audioFormat: 'ogg_opus',
      region: 'auto',
      oggOpusEncoder: { frameDurationMs: 20, application: 'audio' },
      extraParams: { server_post_process: 'false' },
      livekitEgress: {
        roomName: 'test-room',
        publisherId: 'custom-avatar',
        idleTimeout: 25,
        extraAttributes: {
          'lk.publish_on_behalf': 'test-agent',
          livekit_agent_identity: 'test-agent',
        },
      },
    });
    const claims = await new TokenVerifier(livekit.livekitApiKey, livekit.livekitApiSecret).verify(
      config.livekitEgress!.apiToken!,
    );
    expect(claims).toMatchObject({
      sub: 'custom-avatar',
      name: 'Custom Avatar',
      kind: 'agent',
      attributes: { 'lk.publish_on_behalf': 'test-agent' },
      video: {
        roomJoin: true,
        room: 'test-room',
        canSubscribe: false,
        canPublish: true,
        canPublishData: true,
        canPublishSources: ['camera', 'microphone'],
      },
    });
    expect(claims.exp! - claims.nbf!).toBe(3600);
    expect(config.livekitEgress).not.toHaveProperty('apiSecret');
  });

  it('uses environment defaults and explicit PCM/rate overrides', async () => {
    vi.stubEnv('SPATIUS_API_KEY', 'env-key');
    vi.stubEnv('SPATIUS_APP_ID', 'env-app');
    vi.stubEnv('SPATIUS_AVATAR_ID', 'env-avatar');
    vi.stubEnv('SPATIUS_REGION', 'us-west');
    vi.stubEnv('SPATIUS_AUDIO_FORMAT', 'pcm_s16le');
    avatar = new AvatarSession({ sampleRate: 44100 });
    await avatar.start(session, room, { ...livekit, livekitRoomName: 'other-room' });
    expect(config).toMatchObject({
      apiKey: 'env-key',
      appId: 'env-app',
      avatarId: 'env-avatar',
      region: 'us-west',
      audioFormat: 'pcm_s16le',
      sampleRate: 44100,
      livekitEgress: { roomName: 'other-room' },
    });
    expect(config.oggOpusEncoder).toBeUndefined();
  });

  it('recovers when interrupted during the first capture', async () => {
    const output = await start();
    const capture = output.captureFrame(frame(1));
    output.clearBuffer();
    await capture;
    output.flush();
    await output.captureFrame(frame(3));
    output.flush();
    await tick();
    expect(sdk.sendAudio.mock.calls).toEqual([
      [new Uint8Array([3, 0, 253, 255]), false],
      [new Uint8Array(), true],
    ]);
  });

  it.each([0, -1, NaN, 44100])(
    'rejects invalid Opus rate %s before opening the SDK',
    async (sampleRate) => {
      await expect(start({ sampleRate })).rejects.toThrow('Failed to start');
      expect(newAvatarSession).not.toHaveBeenCalled();
      expect(session.listenerCount(voice.AgentSessionEventTypes.ConversationItemAdded)).toBe(0);
    },
  );

  it('forwards exactly the PCM view and ends only on flush, not on SDK send completion', async () => {
    const output = await start();
    const backing = new Int16Array([999, 258, -2, 888]);
    await output.captureFrame(new AudioFrame(backing.subarray(1, 3), 24000, 1, 2));
    output.flush();
    await tick();
    expect(sdk.sendAudio.mock.calls).toEqual([
      [new Uint8Array([2, 1, 254, 255]), false],
      [new Uint8Array(), true],
    ]);
    expect(output.pendingPlayoutSegments).toBe(1);
    const started = vi.fn();
    output.on(voice.AudioOutput.EVENT_PLAYBACK_STARTED, started);
    expect(await rpc('playback_started')).toBe('ok');
    expect(started).toHaveBeenCalledOnce();
    expect(await rpc('playback_finished', '{"playback_position":0.375,"interrupted":false}')).toBe(
      'ok',
    );
    await expect(output.waitForPlayout()).resolves.toEqual({
      playbackPosition: 0.375,
      interrupted: false,
    });
  });

  it('rejects spoofed and malformed playback RPCs without releasing playout', async () => {
    const output = await start();
    await output.captureFrame(frame());
    output.flush();
    expect(await rpc('playback_started', '', 'stranger')).toBe('reject');
    expect(
      await rpc('playback_finished', '{"playback_position":1,"interrupted":true}', 'stranger'),
    ).toBe('reject');
    for (const payload of [
      'null',
      'broken',
      '{}',
      '{"playback_position":1e999,"interrupted":false}',
      '{"playback_position":2,"interrupted":"false"}',
    ]) {
      expect(await rpc('playback_finished', payload)).toBe('reject');
    }
    expect(output.pendingPlayoutSegments).toBe(1);
    await rpc('playback_finished', '{"playback_position":-1,"interrupted":true}');
    await expect(output.waitForPlayout()).resolves.toEqual({
      playbackPosition: 0,
      interrupted: true,
    });
  });

  it.each([false, true])(
    'interrupts before/after flush (%s), drops stale frames, and preserves the next turn',
    async (flushed) => {
      const output = await start();
      const sending = new Future<string>();
      sdk.sendAudio.mockReturnValueOnce(sending.await);
      await output.captureFrame(frame(1));
      await tick();
      await output.captureFrame(frame(2));
      if (flushed) output.flush();
      output.clearBuffer();
      output.flush();
      expect(sdk.interrupt).toHaveBeenCalledOnce();
      await rpc('playback_finished', '{"playback_position":0.125,"interrupted":true}');
      await expect(output.waitForPlayout()).resolves.toEqual({
        playbackPosition: 0.125,
        interrupted: true,
      });
      await output.captureFrame(frame(3));
      output.flush();
      sending.resolve('request-id');
      await tick();
      expect(sdk.sendAudio.mock.calls).toEqual([
        [new Uint8Array([1, 0, 255, 255]), false],
        [new Uint8Array([3, 0, 253, 255]), false],
        [new Uint8Array(), true],
      ]);
      await rpc('playback_finished', '{"playback_position":0.5,"interrupted":false}');
      expect(output.pendingPlayoutSegments).toBe(0);
    },
  );

  it('times out a missing interrupt acknowledgement without finishing a later segment', async () => {
    const output = await start();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await output.captureFrame(frame());
    output.flush();
    await tick();
    sdk.interrupt.mockRejectedValueOnce(new Error('network failure'));
    output.clearBuffer();
    await output.captureFrame(frame(3));
    output.flush();
    await tick();
    await vi.advanceTimersByTimeAsync(1999);
    expect(output.pendingPlayoutSegments).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(output.pendingPlayoutSegments).toBe(1);
    await rpc('playback_finished', '{"playback_position":0.5,"interrupted":false}');
    expect(output.pendingPlayoutSegments).toBe(0);
  });

  it.each([false, true])(
    'survives SDK cancellation of an in-flight send (end=%s)',
    async (blockEnd) => {
      const output = await start();
      const sending = new Future<string>();
      let blocked = false;
      sdk.sendAudio.mockImplementation(async (_audio, end) => {
        if (!blocked && end === blockEnd) {
          blocked = true;
          return sending.await;
        }
        return 'next-request';
      });
      sdk.interrupt.mockImplementationOnce(async () => {
        // The real SDK invalidates the active request before queuing the interrupt.
        sending.reject(new Error('Audio request has already finished'));
        return 'interrupted-request';
      });
      await output.captureFrame(frame(1));
      output.flush();
      await tick();
      expect(blocked).toBe(true);
      output.clearBuffer();
      await tick();
      expect(sdk.close).not.toHaveBeenCalled();
      await rpc('playback_finished', '{"playback_position":0,"interrupted":true}');
      await output.captureFrame(frame(3));
      output.flush();
      await tick();
      expect(sdk.sendAudio.mock.calls.slice(-2)).toEqual([
        [new Uint8Array([3, 0, 253, 255]), false],
        [new Uint8Array(), true],
      ]);
      await rpc('playback_finished', '{"playback_position":0.5,"interrupted":false}');
      expect(output.pendingPlayoutSegments).toBe(0);
    },
  );

  it('closes on send failure even without an SDK close callback', async () => {
    const output = await start();
    sdk.sendAudio.mockRejectedValueOnce(new Error('send failed'));
    await output.captureFrame(frame());
    output.flush();
    await tick();
    await expect(output.waitForPlayout()).resolves.toMatchObject({ interrupted: true });
    expect(sdk.close).toHaveBeenCalledOnce();
    expect(handlers.size).toBe(0);
    await expect(output.captureFrame(frame())).rejects.toThrow('closed');
    expect(output.pendingPlayoutSegments).toBe(0);
  });

  it('releases playout and listeners on remote close, even when SDK cleanup fails', async () => {
    const output = await start();
    await output.captureFrame(frame());
    output.flush();
    await tick();
    sdk.close.mockRejectedValueOnce(new Error('close failed'));
    config.onClose!();
    await Promise.all([avatar.aclose(), avatar.aclose()]);
    await expect(output.waitForPlayout()).resolves.toMatchObject({ interrupted: true });
    expect(sdk.close).toHaveBeenCalledOnce();
    expect(handlers.size).toBe(0);
    expect(room.eventNames()).toEqual([]);
    expect(session.listenerCount(voice.AgentSessionEventTypes.Close)).toBe(0);
    expect(session.listenerCount(voice.AgentSessionEventTypes.ConversationItemAdded)).toBe(0);
  });

  it.each(['init', 'start'] as const)('rolls back SDK %s failures', async (phase) => {
    sdk[phase].mockRejectedValueOnce(new Error('setup failed'));
    await expect(start()).rejects.toThrow('Failed to start');
    expect(sdk.close).toHaveBeenCalledOnce();
    expect(session.output.audio).toBeNull();
    expect(room.eventNames()).toEqual([]);
    await expect(avatar.start(session, room, livekit)).rejects.toThrow('closed');
  });

  it('does not attach audio or start transport when closed during init', async () => {
    const initializing = new Future<void>();
    sdk.init.mockReturnValueOnce(initializing.await);
    const starting = start();
    const rejection = expect(starting).rejects.toThrow('Failed to start');
    await vi.waitFor(() => expect(sdk.init).toHaveBeenCalledOnce());
    await avatar.aclose();
    initializing.resolve();
    await rejection;
    expect(sdk.start).not.toHaveBeenCalled();
    expect(session.output.audio).toBeNull();
  });

  it('releases speech during real AgentSession shutdown before onExit finishes', async () => {
    const output = await start();
    let exited = false;
    class Agent extends voice.Agent {
      override async onExit() {
        await output.waitForPlayout();
        exited = true;
      }
    }
    await session.start({ agent: new Agent({ instructions: 'test' }) });
    const speech = session.say('hello', {
      audio: new ReadableStream<AudioFrame>({
        start(controller) {
          controller.enqueue(frame());
          controller.close();
        },
      }),
    });
    await vi.waitFor(() => expect(sdk.sendAudio).toHaveBeenCalled());
    await session.close();
    await avatar.aclose();
    expect(speech.interrupted).toBe(true);
    expect(exited).toBe(true);
    expect(output.pendingPlayoutSegments).toBe(0);
  });
});
