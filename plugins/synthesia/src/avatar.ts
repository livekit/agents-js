// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { DEFAULT_API_CONNECT_OPTIONS, getJobContext, voice } from '@livekit/agents';
import type { RemoteParticipant, RemoteTrackPublication, Room } from '@livekit/rtc-node';
import { RoomEvent, TrackKind } from '@livekit/rtc-node';
import type { VideoGrant } from 'livekit-server-sdk';
import { AccessToken } from 'livekit-server-sdk';
import { SynthesiaAPI } from './api.js';
import { ErrorType, SynthesiaError } from './errors.js';
import { log } from './log.js';
import {
  AVATAR_IDENTITY,
  AVATAR_NAME,
  type AvatarConfig,
  DEFAULT_API_URL,
  DEFAULT_JOIN_TIMEOUT,
  DEFAULT_SWAP_TIMEOUT,
  TOKEN_TTL,
} from './types.js';

const ATTRIBUTE_PUBLISH_ON_BEHALF = 'lk.publish_on_behalf';

enum State {
  IDLE,
  STARTED,
  CLOSED,
}

/** Options for configuring an AvatarSession. @public */
export interface AvatarSessionOptions {
  /** Synthesia API key. Falls back to `SYNTHESIA_API_KEY`. */
  apiKey?: string | null;
  /** Synthesia API URL. Falls back to `SYNTHESIA_API_URL`. */
  apiUrl?: string | null;
  /** Maximum time in milliseconds to wait for the avatar to join. */
  joinTimeout?: number;
  /** Identity for the avatar participant. */
  avatarParticipantIdentity?: string | null;
  /** Display name for the avatar participant. */
  avatarParticipantName?: string | null;
}

/** Optional LiveKit credentials for {@link AvatarSession.start}. @public */
export interface StartOptions {
  livekitUrl?: string | null;
  livekitApiKey?: string | null;
  livekitApiSecret?: string | null;
}

/** A Synthesia interactive avatar for a LiveKit voice agent. @public */
export class AvatarSession extends voice.AvatarSession {
  private avatarIds: readonly string[];
  #apiKey: string;
  private apiUrl: string;
  private joinTimeout: number;
  private avatarParticipantIdentity: string;
  private avatarParticipantName: string;
  private state = State.IDLE;
  private starting = false;
  private room?: Room;
  private sessionIdValue: string | null = null;
  private audioOutput?: voice.DataStreamAudioOutput;
  private closePromise?: Promise<void>;
  private teardownPromise?: Promise<void>;

  constructor(avatarConfig: AvatarConfig, options: AvatarSessionOptions = {}) {
    super();
    if (options.avatarParticipantIdentity !== undefined) {
      requirePresent(options.avatarParticipantIdentity, 'avatarParticipantIdentity');
    }
    if (options.avatarParticipantName !== undefined) {
      requirePresent(options.avatarParticipantName, 'avatarParticipantName');
    }
    const apiKey = options.apiKey ?? process.env.SYNTHESIA_API_KEY;
    if (!apiKey) {
      throw new SynthesiaError(
        'a Synthesia API key is required: pass apiKey or set SYNTHESIA_API_KEY',
      );
    }
    this.avatarIds = [...avatarConfig.avatarIds];
    this.#apiKey = apiKey;
    this.apiUrl = options.apiUrl ?? process.env.SYNTHESIA_API_URL ?? DEFAULT_API_URL;
    this.joinTimeout = options.joinTimeout ?? DEFAULT_JOIN_TIMEOUT;
    this.avatarParticipantIdentity = options.avatarParticipantIdentity ?? AVATAR_IDENTITY;
    this.avatarParticipantName = options.avatarParticipantName ?? AVATAR_NAME;
  }

  override get avatarIdentity(): string {
    return this.avatarParticipantIdentity;
  }

  override get provider(): string {
    return 'synthesia';
  }

  /** Synthesia session ID after provisioning succeeds, otherwise `null`. */
  get sessionId(): string | null {
    return this.sessionIdValue;
  }

  async start(
    agentSession: voice.AgentSession,
    room: Room,
    options: StartOptions = {},
  ): Promise<void> {
    if (this.starting) throw new SynthesiaError('start() is already in progress');
    this.starting = true;
    try {
      if (this.closePromise) {
        try {
          await this.closePromise;
        } catch (cause) {
          throw new SynthesiaError(
            'the previous avatar session did not tear down cleanly; not restarting',
            { cause },
          );
        }
        this.closePromise = undefined;
        this.teardownPromise = undefined;
      }
      if (this.state === State.STARTED) return;

      const livekitUrl = options.livekitUrl ?? process.env.LIVEKIT_URL;
      const livekitApiKey = options.livekitApiKey ?? process.env.LIVEKIT_API_KEY;
      const livekitApiSecret = options.livekitApiSecret ?? process.env.LIVEKIT_API_SECRET;
      if (![livekitUrl, livekitApiKey, livekitApiSecret].every(isPresent)) {
        throw new SynthesiaError(
          'LiveKit url, API key, and API secret are required: pass them or set LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET',
        );
      }
      const normalizedUrl = toWebSocketUrl(livekitUrl!);
      if (!normalizedUrl.startsWith('ws://') && !normalizedUrl.startsWith('wss://')) {
        throw new SynthesiaError(
          `livekitUrl ${JSON.stringify(normalizedUrl)} is not a ws:// or wss:// URL`,
        );
      }

      this.state = State.IDLE;
      this.room = room;
      try {
        await super.start(agentSession, room);
        const api = new SynthesiaAPI({ apiKey: this.#apiKey, apiUrl: this.apiUrl });
        const response = await api.startSession(
          {
            avatarIds: this.avatarIds,
            livekitUrl: normalizedUrl,
            livekitToken: await this.mintToken(room, livekitApiKey!, livekitApiSecret!),
          },
          { ...DEFAULT_API_CONNECT_OPTIONS, timeoutMs: this.joinTimeout, maxRetry: 0 },
        );
        this.sessionIdValue = response.sessionId;
        const audioOutput = new voice.DataStreamAudioOutput({
          room,
          destinationIdentity: this.avatarIdentity,
          waitRemoteTrack: TrackKind.KIND_VIDEO,
        });
        agentSession.output.replaceAudioTail(audioOutput);
        this.audioOutput = audioOutput;
        await this.waitForJoin({ timeout: this.joinTimeout });
      } catch (error) {
        await this.aclose().catch(() => undefined);
        await this.discardPartialStart();
        if (isJoinTimeout(error)) {
          throw new SynthesiaError(`avatar did not join within ${this.joinTimeout}ms`, {
            type: ErrorType.TIMEOUT,
            cause: error,
          });
        }
        throw error;
      }

      if (this.isClosed()) {
        await this.closePromise;
        await this.discardPartialStart();
        throw new SynthesiaError('avatar session was closed while starting');
      }
      room.on(RoomEvent.Disconnected, this.onRoomDisconnected);
      room.on(RoomEvent.TrackUnpublished, this.onTrackUnpublished);
      room.on(RoomEvent.ParticipantDisconnected, this.onParticipantDisconnected);
      this.state = State.STARTED;
    } finally {
      this.starting = false;
    }
  }

  /** Switch the rendered avatar during a started session. */
  async swapAvatar(avatarId: string, { timeout = DEFAULT_SWAP_TIMEOUT } = {}): Promise<string> {
    if (this.state !== State.STARTED || this.teardownPromise || !this.room) {
      throw new SynthesiaError('swapAvatar() requires a started avatar session');
    }
    if (avatarId !== 'default' && !this.avatarIds.includes(avatarId)) {
      throw new SynthesiaError(`avatar ${JSON.stringify(avatarId)} was not in initial avatarIds`, {
        type: ErrorType.UNKNOWN_AVATAR,
      });
    }

    let raw: string;
    try {
      raw = await this.room.localParticipant!.performRpc({
        destinationIdentity: this.avatarIdentity,
        method: 'swapAvatar',
        payload: JSON.stringify({ avatar_id: avatarId }),
        responseTimeout: timeout,
      });
    } catch (cause) {
      throw new SynthesiaError(`avatar swap RPC failed: ${String(cause)}`, {
        type: ErrorType.CONNECTION,
        cause,
      });
    }

    let response: unknown;
    try {
      response = JSON.parse(raw) as unknown;
    } catch (cause) {
      throw new SynthesiaError('avatar swap returned a malformed response', { cause });
    }
    const result = isRecord(response) ? response.avatar_id : undefined;
    if (!isRecord(response) || response.error || typeof result !== 'string') {
      const detail = isRecord(response) ? response.error : undefined;
      throw new SynthesiaError(`avatar swap failed: ${detail || raw}`);
    }
    return result;
  }

  override async aclose(): Promise<void> {
    if (this.closePromise) {
      await this.closePromise.catch(() => undefined);
      return;
    }
    this.state = State.CLOSED;
    this.sessionIdValue = null;
    this.closePromise = this.closeImpl();
    return this.closePromise;
  }

  private async closeImpl(): Promise<void> {
    try {
      const audioOutput = this.audioOutput;
      this.audioOutput = undefined;
      await audioOutput?.aclose();
      if (this.room) {
        this.room.off(RoomEvent.Disconnected, this.onRoomDisconnected);
        this.room.off(RoomEvent.TrackUnpublished, this.onTrackUnpublished);
        this.room.off(RoomEvent.ParticipantDisconnected, this.onParticipantDisconnected);
      }
      await super.aclose();
    } finally {
      this.room = undefined;
    }
  }

  private async discardPartialStart(): Promise<void> {
    const audioOutput = this.audioOutput;
    this.audioOutput = undefined;
    await audioOutput?.aclose();
    this.sessionIdValue = null;
  }

  private async mintToken(room: Room, apiKey: string, apiSecret: string): Promise<string> {
    const jobContext = getJobContext(false);
    const agentIdentity =
      jobContext?.agent?.identity ??
      room.localParticipant?.identity ??
      jobContext?.info.acceptArguments.identity;
    if (!isPresent(agentIdentity)) {
      throw new SynthesiaError(
        "the room's local participant has no identity; connect the room before starting the avatar session",
      );
    }
    const roomName = room.name || jobContext?.job.room?.name;
    if (!isPresent(roomName)) {
      throw new SynthesiaError(
        'failed to get room name; connect the room before starting outside a job context',
      );
    }
    const token = new AccessToken(apiKey, apiSecret, {
      identity: this.avatarIdentity,
      name: this.avatarParticipantName,
      ttl: TOKEN_TTL,
    });
    token.kind = 'agent';
    token.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    } as VideoGrant);
    token.attributes = { [ATTRIBUTE_PUBLISH_ON_BEHALF]: agentIdentity };
    return token.toJwt();
  }

  private onRoomDisconnected = () => {
    if (this.teardownPromise || this.state === State.CLOSED) return;
    log().info('avatar session ended');
    this.beginTeardown();
  };

  private onTrackUnpublished = (
    publication: RemoteTrackPublication,
    participant: RemoteParticipant,
  ) => {
    if (participant.identity === this.avatarIdentity && publication.kind === TrackKind.KIND_VIDEO) {
      this.reportAvatarLost();
    }
  };

  private onParticipantDisconnected = (participant: RemoteParticipant) => {
    if (participant.identity === this.avatarIdentity) this.reportAvatarLost();
  };

  private reportAvatarLost() {
    if (this.teardownPromise || this.state === State.CLOSED || !this.room?.isConnected) return;
    log().warn('avatar left the room unexpectedly');
    this.beginTeardown();
  }

  private beginTeardown() {
    if (this.teardownPromise || this.state === State.CLOSED) return;
    this.teardownPromise = this.aclose();
    void this.teardownPromise.catch((error) => log().error({ error }, 'avatar teardown failed'));
  }

  private isClosed(): boolean {
    return this.state === State.CLOSED;
  }
}

function isPresent(value: string | null | undefined): value is string {
  return Boolean(value?.trim());
}

function requirePresent(value: string | null, name: string): asserts value is string {
  if (!isPresent(value)) throw new SynthesiaError(`${name} must be a non-empty string`);
}

function toWebSocketUrl(url: string): string {
  if (url.startsWith('https://')) return 'wss://' + url.slice('https://'.length);
  if (url.startsWith('http://')) return 'ws://' + url.slice('http://'.length);
  return url;
}

function isJoinTimeout(error: unknown): boolean {
  return error instanceof Error && error.message === 'timed out waiting for avatar participant';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
