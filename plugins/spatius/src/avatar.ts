// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { getJobContext, log, voice } from '@livekit/agents';
import type { AudioFrame, Room, RpcInvocationData } from '@livekit/rtc-node';
import {
  AudioFormat,
  type OggOpusEncoderConfig,
  type AvatarSession as SDKSession,
  type SessionConfig,
  newAvatarSession,
} from '@spatius/server-sdk';
import { AccessToken, TrackSource } from 'livekit-server-sdk';
import type { ReadableStreamDefaultReader } from 'node:stream/web';

const PLAYBACK_STARTED = 'lk.playback_started';
const PLAYBACK_FINISHED = 'lk.playback_finished';
const PUBLISH_ON_BEHALF = 'lk.publish_on_behalf';
const CLEAR_BUFFER_TIMEOUT = 2000;

/** Configuration for the Spatius avatar. Credentials default to the corresponding SPATIUS_* variables.
 * @public
 */
export interface AvatarSessionOptions {
  apiKey?: string;
  appId?: string;
  avatarId?: string;
  /** Defaults to SPATIUS_REGION or automatic region discovery. */
  region?: string;
  consoleEndpointUrl?: string;
  ingressEndpointUrl?: string;
  avatarParticipantIdentity?: string;
  avatarParticipantName?: string;
  /** Worker idle timeout in milliseconds; zero disables it. */
  idleTimeout?: number;
  /** Defaults to the session TTS rate, or 24000 Hz for realtime models. */
  sampleRate?: number;
  /** Defaults to SPATIUS_AUDIO_FORMAT or ogg_opus. Both formats accept raw PCM frames. */
  audioFormat?: SessionConfig['audioFormat'];
  /** Encoded audio bitrate in bits/s; zero selects the SDK default. */
  bitrate?: number;
  /** Opus frame duration in milliseconds. Defaults to 20. */
  opusFrameDuration?: OggOpusEncoderConfig['frameDurationMs'];
  /** Defaults to audio. */
  opusApplication?: OggOpusEncoderConfig['application'];
  extraParams?: Record<string, string>;
}

/** LiveKit egress credentials; omitted credentials use LIVEKIT_* environment variables.
 * @public
 */
export interface StartOptions {
  livekitUrl?: string;
  livekitApiKey?: string;
  livekitApiSecret?: string;
  /** Defaults to the connected room's name. */
  livekitRoomName?: string;
}

/** A Spatius configuration or session startup error.
 * @public
 */
export class SpatiusException extends Error {
  override name = 'SpatiusException';
}

/**
 * Forwards agent speech to Spatius, which publishes synchronized avatar tracks into LiveKit.
 * Start this before AgentSession.start(). Sessions are single-use; call aclose() to release them.
 * @public
 */
export class AvatarSession extends voice.AvatarSession {
  private readonly options: AvatarSessionOptions;
  private readonly config: SessionConfig;
  private sdk?: SDKSession;
  private audio?: SpatiusAudioOutput;
  private agentSession?: voice.AgentSession;
  private room?: Room;
  private readonly registeredRpcs: string[] = [];
  private reader?: ReadableStreamDefaultReader<voice.QueueAudioOutputItem>;
  private forwardTask?: Promise<void>;
  private interruptTask?: Promise<void>;
  private startTask?: Promise<void>;
  private closeTask?: Promise<void>;
  private closed = false;
  private readSegments = 0;
  private discardThrough = 0;
  private hasRequest = false;
  private clearTimer?: ReturnType<typeof setTimeout>;
  private readonly logger = log().child({ module: 'SpatiusAvatar' });

  constructor(options: AvatarSessionOptions = {}) {
    super();
    this.options = { ...options };
    const audioFormat = options.audioFormat ?? process.env.SPATIUS_AUDIO_FORMAT ?? 'ogg_opus';
    if (audioFormat !== 'ogg_opus' && audioFormat !== 'pcm_s16le') {
      throw new SpatiusException(`unsupported audioFormat: ${audioFormat}`);
    }
    for (const [name, value] of Object.entries({
      idleTimeout: options.idleTimeout ?? 0,
      bitrate: options.bitrate ?? 0,
    })) {
      if (!Number.isFinite(value) || value < 0) {
        throw new SpatiusException(`${name} must be finite and non-negative`);
      }
    }
    this.config = {
      apiKey: required(options.apiKey, 'SPATIUS_API_KEY'),
      appId: required(options.appId, 'SPATIUS_APP_ID'),
      avatarId: required(options.avatarId, 'SPATIUS_AVATAR_ID'),
      region: options.region ?? process.env.SPATIUS_REGION ?? 'auto',
      consoleEndpointUrl: options.consoleEndpointUrl ?? process.env.SPATIUS_CONSOLE_ENDPOINT,
      ingressEndpointUrl: options.ingressEndpointUrl ?? process.env.SPATIUS_INGRESS_ENDPOINT,
      audioFormat,
      bitrate: options.bitrate ?? 0,
      oggOpusEncoder:
        audioFormat === AudioFormat.OGG_OPUS
          ? {
              frameDurationMs: options.opusFrameDuration ?? 20,
              application: options.opusApplication ?? 'audio',
            }
          : undefined,
      extraParams: { ...options.extraParams },
      onError: (error) => this.logger.warn({ error }, 'Spatius session error'),
      onClose: this.onClose,
    };
  }

  override get avatarIdentity(): string {
    return this.options.avatarParticipantIdentity ?? 'spatius-avatar-agent';
  }

  override get provider(): string {
    return 'spatius';
  }

  /** Start the SDK and attach the avatar audio output. Concurrent starts share one operation. */
  override async start(
    agentSession: voice.AgentSession,
    room: Room,
    options: StartOptions = {},
  ): Promise<void> {
    this.assertOpen();
    this.startTask ??= this.startImpl(agentSession, room, options);
    return this.startTask;
  }

  private async startImpl(agentSession: voice.AgentSession, room: Room, options: StartOptions) {
    try {
      await super.start(agentSession, room);
      this.assertOpen();
      this.agentSession = agentSession;
      this.room = room;
      agentSession.on(voice.AgentSessionEventTypes.Close, this.onClose);
      const url = required(options.livekitUrl, 'LIVEKIT_URL');
      const apiKey = required(options.livekitApiKey, 'LIVEKIT_API_KEY');
      const apiSecret = required(options.livekitApiSecret, 'LIVEKIT_API_SECRET');
      const roomName = options.livekitRoomName ?? room.name;
      const identity = getJobContext(false)?.agent?.identity || room.localParticipant?.identity;
      if (!roomName || !identity || !room.localParticipant) {
        throw new SpatiusException('a room name and local participant identity are required');
      }
      const sampleRate = this.options.sampleRate ?? agentSession.tts?.sampleRate ?? 24000;
      if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
        throw new SpatiusException('sampleRate must be a positive integer');
      }
      if (this.config.oggOpusEncoder && ![8000, 12000, 16000, 24000, 48000].includes(sampleRate)) {
        throw new SpatiusException(`unsupported Opus sampleRate: ${sampleRate}`);
      }
      const token = new AccessToken(apiKey, apiSecret, {
        identity: this.avatarIdentity,
        name: this.options.avatarParticipantName ?? 'spatius-avatar-agent',
        ttl: 3600,
      });
      token.kind = 'agent';
      token.attributes = { [PUBLISH_ON_BEHALF]: identity };
      token.addGrant({
        roomJoin: true,
        room: roomName,
        canSubscribe: false,
        canPublish: true,
        canPublishData: true,
        canPublishSources: [TrackSource.CAMERA, TrackSource.MICROPHONE],
      });
      const apiToken = await token.toJwt();
      this.assertOpen();
      this.sdk = newAvatarSession({
        ...this.config,
        sampleRate,
        expireAt: new Date(Date.now() + 3600_000),
        livekitEgress: {
          url,
          apiToken,
          roomName,
          publisherId: this.avatarIdentity,
          extraAttributes: { [PUBLISH_ON_BEHALF]: identity, livekit_agent_identity: identity },
          idleTimeout: (this.options.idleTimeout ?? 0) / 1000,
        },
      });
      await this.sdk.init();
      this.assertOpen();
      await this.sdk.start();
      this.assertOpen();

      this.audio = new SpatiusAudioOutput(sampleRate);
      this.audio.on('clear_buffer', this.onClearBuffer);
      for (const [method, handler] of [
        [PLAYBACK_STARTED, this.onPlaybackStarted],
        [PLAYBACK_FINISHED, this.onPlaybackFinished],
      ] as const) {
        room.localParticipant.registerRpcMethod(method, handler);
        this.registeredRpcs.push(method);
      }
      this.reader = this.audio.stream().getReader();
      this.forwardTask = this.forwardAudio().catch((error) => {
        if (!this.closed) {
          this.logger.warn({ error }, 'Spatius audio forwarding failed');
          this.onClose();
        }
      });
      agentSession.output.audio = this.audio;
    } catch (cause) {
      await this.aclose();
      throw new SpatiusException('Failed to start Spatius avatar session', { cause });
    }
  }

  private assertOpen() {
    if (this.closed) throw new SpatiusException('Spatius avatar session is closed');
  }

  private async forwardAudio() {
    const reader = this.reader!;
    try {
      while (!this.closed) {
        const { done, value } = await reader.read();
        if (done || this.closed) break;
        // Do not let a new utterance overtake an interrupt of the previous request.
        await this.interruptTask;
        if (this.closed) break;
        const discard = this.readSegments < this.discardThrough;
        if (value instanceof voice.AudioSegmentEnd) {
          this.readSegments++;
          if (!discard) await this.sdk!.sendAudio(new Uint8Array(), true);
        } else if (!discard) {
          this.hasRequest = true;
          await this.sdk!.sendAudio(
            new Uint8Array(value.data.buffer, value.data.byteOffset, value.data.byteLength),
            false,
          );
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private onPlaybackStarted = async (data: RpcInvocationData): Promise<string> => {
    if (this.closed || data.callerIdentity !== this.avatarIdentity) return 'reject';
    if (this.audio?.pendingPlayoutSegments) this.audio.notifyPlaybackStarted();
    return 'ok';
  };

  private onPlaybackFinished = async (data: RpcInvocationData): Promise<string> => {
    if (this.closed || data.callerIdentity !== this.avatarIdentity) return 'reject';
    let payload;
    try {
      payload = JSON.parse(data.payload);
      if (
        typeof payload?.playback_position !== 'number' ||
        !Number.isFinite(payload.playback_position) ||
        typeof payload.interrupted !== 'boolean'
      ) {
        return 'reject';
      }
    } catch {
      return 'reject';
    }
    if (this.audio?.pendingPlayoutSegments) {
      this.audio.notifyPlaybackFinished(
        Math.max(0, payload.playback_position),
        payload.interrupted,
      );
    }
    if (!this.audio?.pendingPlayoutSegments) this.cancelClearTimer();
    return 'ok';
  };

  private onClearBuffer = (): void => {
    const audio = this.audio;
    if (this.closed || !audio?.pendingPlayoutSegments) return;
    // QueueAudioOutput writes a boundary even when clearBuffer precedes flush.
    // Drop through that boundary, including frames queued before the reader ran.
    const target = audio.capturedPlayoutSegments;
    this.discardThrough = target;
    if (this.hasRequest && !this.interruptTask) {
      this.hasRequest = false;
      this.interruptTask = this.sdk!.interrupt()
        .catch((error) => {
          this.logger.debug({ error }, 'Spatius interrupt failed');
        })
        .then(() => {
          this.interruptTask = undefined;
        });
    }
    this.cancelClearTimer();
    this.clearTimer = setTimeout(() => {
      this.clearTimer = undefined;
      // Complete only the segments present at interrupt time, never a later turn.
      while (audio.capturedPlayoutSegments - audio.pendingPlayoutSegments < target) {
        audio.notifyPlaybackFinished(0, true);
      }
    }, CLEAR_BUFFER_TIMEOUT);
  };

  private cancelClearTimer() {
    clearTimeout(this.clearTimer);
    this.clearTimer = undefined;
  }

  private onClose = (): void => {
    if (!this.closed) {
      void this.aclose().catch((error) => this.logger.warn({ error }, 'Spatius cleanup failed'));
    }
  };

  /** Close transport, release pending playout, and unregister session listeners and RPCs. */
  override async aclose(): Promise<void> {
    if (this.closeTask) return this.closeTask;
    this.closed = true;
    this.closeTask = this.closeImpl();
    return this.closeTask;
  }

  private async closeImpl() {
    this.cancelClearTimer();
    this.agentSession?.off(voice.AgentSessionEventTypes.Close, this.onClose);
    this.audio?.off('clear_buffer', this.onClearBuffer);
    this.audio?.stop();
    for (const method of this.registeredRpcs.splice(0)) {
      this.room?.localParticipant?.unregisterRpcMethod(method);
    }
    // Cancel the reader before awaiting transport work: queued captureFrame calls
    // must be released even when the SDK is still sending or closing.
    await this.reader?.cancel().catch(() => {});
    await this.audio?.aclose();
    try {
      await this.sdk?.close();
    } catch (error) {
      this.logger.warn({ error }, 'Error closing Spatius SDK');
    } finally {
      await this.forwardTask;
      await this.interruptTask;
      await super.aclose();
    }
  }
}

// Keep an output already held by a running activity from accepting speech after disconnect.
class SpatiusAudioOutput extends voice.QueueAudioOutput {
  private stopped = false;

  override async captureFrame(frame: AudioFrame) {
    if (this.stopped) throw new SpatiusException('Spatius audio output is closed');
    if (frame.channels !== 1 || frame.sampleRate !== this.sampleRate) {
      throw new SpatiusException(`expected mono PCM at ${this.sampleRate} Hz`);
    }
    try {
      await super.captureFrame(frame);
    } finally {
      if (this.stopped) this.stop();
    }
  }

  stop() {
    this.stopped = true;
    this.abandonOpenSegment();
    while (this.pendingPlayoutSegments) this.notifyPlaybackFinished(0, true);
  }
}

function required(value: string | undefined, env: string): string {
  const resolved = value ?? process.env[env];
  if (!resolved) throw new SpatiusException(`${env} must be set or passed explicitly`);
  return resolved;
}
