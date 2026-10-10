// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type APIConnectOptions,
  DEFAULT_API_CONNECT_OPTIONS,
  getJobContext,
  voice,
} from '@livekit/agents';
import type { Room } from '@livekit/rtc-node';
import { TrackKind } from '@livekit/rtc-node';
import type { VideoGrant } from 'livekit-server-sdk';
import { AccessToken, TrackSource } from 'livekit-server-sdk';
import { createHash } from 'node:crypto';
import { type AvatarSessionInfo, AvatarSessionStartError, BosonAvatarAPI } from './api.js';
import { BosonAvatarException } from './errors.js';
import { log } from './log.js';

/** @public */
export const SAMPLE_RATE = 24000;
/** @public */
export const MAX_DURATION_MS = 14_400_000;

const AVATAR_AGENT_IDENTITY = 'boson-avatar-agent';
const AVATAR_AGENT_NAME = 'Boson Avatar';
const ATTRIBUTE_PUBLISH_ON_BEHALF = 'lk.publish_on_behalf';
const UUID_NAMESPACE_URL = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';

/** @public */
export interface AvatarSessionOptions {
  /** Boson Avatar asset ID. Falls back to `BOSON_AVATAR_ID`. */
  avatarId?: string | null;
  /** Boson API key. Falls back to `BOSON_API_KEY` or `BOSONAI_API_KEY`. */
  apiKey?: string | null;
  /** Avatar service URL. Falls back to `BOSON_AVATAR_API_URL`. */
  apiUrl?: string | null;
  /** Optional output width. Must be provided with `height`. */
  width?: number | null;
  /** Optional output height. Must be provided with `width`. */
  height?: number | null;
  /** Optional maximum Avatar session duration, in milliseconds. */
  maxDurationMs?: number | null;
  /** LiveKit identity used by the Avatar. */
  avatarParticipantIdentity?: string | null;
  /** LiveKit display name used by the Avatar. */
  avatarParticipantName?: string | null;
  /** Optional stable UUID for provider-session creation. */
  idempotencyKey?: string | null;
  /** API retry and timeout options. */
  connOptions?: APIConnectOptions;
}

/** @public */
export interface StartOptions {
  livekitUrl?: string | null;
  livekitApiKey?: string | null;
  livekitApiSecret?: string | null;
}

/** A provider-agnostic audio session for Boson Higgs Avatar rendering. @public */
export class AvatarSession extends voice.AvatarSession {
  private readonly avatarId: string;
  private readonly width: number | null;
  private readonly height: number | null;
  private readonly maxDurationMs: number | null;
  private readonly avatarParticipantIdentity: string;
  private readonly avatarParticipantName: string;
  private readonly idempotencyKey: string | null;
  private readonly api: BosonAvatarAPI;

  private sessionInfo: AvatarSessionInfo | null = null;
  private startCalled = false;
  private closed = false;
  private closeRequested = false;
  private baseStartPromise: Promise<unknown> | null = null;
  private createPromise: Promise<AvatarSessionInfo> | null = null;
  private startupCleanupPromise: Promise<void> | null = null;
  private shutdownPromise: Promise<void> | null = null;
  private agentClosePromise: Promise<void> | null = null;
  private trackedAgentSession: voice.AgentSession | null = null;
  #logger = log();

  constructor(options: AvatarSessionOptions = {}) {
    super();
    const avatarId = resolveString(options.avatarId, 'BOSON_AVATAR_ID');
    if (!avatarId) {
      throw new BosonAvatarException(
        'avatarId must be set by passing it to AvatarSession or setting the BOSON_AVATAR_ID environment variable',
      );
    }
    this.avatarId = avatarId;
    this.width = positiveInteger(options.width, 'width');
    this.height = positiveInteger(options.height, 'height');
    if ((this.width === null) !== (this.height === null)) {
      throw new BosonAvatarException('width and height must be provided together');
    }
    this.maxDurationMs = durationMs(options.maxDurationMs);
    this.avatarParticipantIdentity = trimmedOrDefault(
      options.avatarParticipantIdentity,
      AVATAR_AGENT_IDENTITY,
    );
    this.avatarParticipantName = trimmedOrDefault(options.avatarParticipantName, AVATAR_AGENT_NAME);
    this.idempotencyKey = validateUuid(options.idempotencyKey);
    this.api = new BosonAvatarAPI({
      apiKey: options.apiKey,
      apiUrl: options.apiUrl,
      connOptions: options.connOptions ?? DEFAULT_API_CONNECT_OPTIONS,
    });
  }

  override get avatarIdentity(): string {
    return this.avatarParticipantIdentity;
  }

  override get provider(): string {
    return 'boson';
  }

  /** Boson Avatar session ID after creation, retained until provider deletion succeeds. */
  get sessionId(): string | null {
    return this.sessionInfo?.id ?? null;
  }

  async start(
    agentSession: voice.AgentSession,
    room: Room,
    options: StartOptions = {},
  ): Promise<string> {
    if (this.startCalled) {
      throw new Error('AvatarSession.start() called twice; create a new AvatarSession.');
    }
    this.startCalled = true;

    const livekitUrl = resolveString(options.livekitUrl, 'LIVEKIT_URL');
    const livekitApiKey = resolveString(options.livekitApiKey, 'LIVEKIT_API_KEY');
    const livekitApiSecret = resolveString(options.livekitApiSecret, 'LIVEKIT_API_SECRET');
    if (!livekitUrl || !livekitApiKey || !livekitApiSecret) {
      throw new BosonAvatarException(
        'livekitUrl, livekitApiKey, and livekitApiSecret must be set by arguments or environment variables',
      );
    }
    const publisherIdentity = localParticipantIdentity(room);
    const roomName = room.name ?? '';
    if (publisherIdentity === this.avatarParticipantIdentity) {
      throw new BosonAvatarException(
        'avatarParticipantIdentity must differ from the local agent participant identity',
      );
    }
    const livekitToken = await this.mintAvatarToken({
      room,
      publisherIdentity,
      livekitApiKey,
      livekitApiSecret,
    });
    if (this.closeRequested || this.closed) {
      throw new Error('AvatarSession was closed before start() completed');
    }

    let startedInfo: AvatarSessionInfo | null = null;
    let baseStarted = false;
    try {
      this.baseStartPromise = super.start(agentSession, room);
      await this.baseStartPromise;
      baseStarted = true;
      this.baseStartPromise = null;
      this.trackedAgentSession = agentSession;
      agentSession.on(voice.AgentSessionEventTypes.Close, this.onAgentSessionClose);
      if (this.closeRequested || this.closed) {
        throw new Error('AvatarSession was closed before start() completed');
      }

      this.createPromise = this.api.startSession({
        avatarId: this.avatarId,
        livekitUrl,
        livekitRoom: roomName,
        livekitToken,
        avatarIdentity: this.avatarParticipantIdentity,
        publisherIdentity,
        width: this.width,
        height: this.height,
        maxDurationMs: this.maxDurationMs,
        idempotencyKey:
          this.idempotencyKey ??
          livekitJobIdempotencyKey({
            livekitUrl,
            roomName,
            avatarId: this.avatarId,
            avatarIdentity: this.avatarParticipantIdentity,
            publisherIdentity,
            width: this.width,
            height: this.height,
            maxDurationMs: this.maxDurationMs,
          }),
      });
      startedInfo = await this.createPromise;
      this.sessionInfo = startedInfo;
      if (this.closeRequested) {
        throw new Error('AvatarSession was closed while start() was in progress');
      }

      const audioOutput = new voice.DataStreamAudioOutput({
        room,
        destinationIdentity: this.avatarParticipantIdentity,
        sampleRate: SAMPLE_RATE,
        waitRemoteTrack: TrackKind.KIND_AUDIO,
      });
      await agentSession.output.replaceAudioTail(audioOutput);
    } catch (error) {
      this.baseStartPromise = null;
      if (!baseStarted) throw error;
      try {
        await this.ensureStartupCleanup(startedInfo);
      } catch {
        // Cleanup is independently logged and must not replace the startup error.
      }
      throw error;
    } finally {
      if (!this.startupCleanupPromise) this.createPromise = null;
    }

    this.#logger.debug(
      {
        'lk.pii.session_id': startedInfo.id,
        'lk.pii.avatar_id': this.avatarId,
      },
      'boson avatar session started',
    );
    return startedInfo.id;
  }

  override async aclose(): Promise<void> {
    this.closeRequested = true;
    if (this.baseStartPromise) {
      try {
        await this.baseStartPromise;
      } catch {
        // The start caller owns the base-start error.
      }
    }
    if (this.startupCleanupPromise || (this.createPromise && !this.sessionInfo)) {
      await (this.startupCleanupPromise ?? this.ensureStartupCleanup(null));
      this.startupCleanupPromise = null;
    }
    if (this.closed && !this.sessionInfo) return;
    if (!this.shutdownPromise) {
      const owned = this.runShutdown();
      this.shutdownPromise = owned;
      const clear = () => {
        if (this.shutdownPromise === owned) this.shutdownPromise = null;
      };
      void owned.then(clear, clear);
    }
    await this.shutdownPromise;
  }

  private ensureStartupCleanup(startedInfo: AvatarSessionInfo | null): Promise<void> {
    if (!this.startupCleanupPromise) {
      const createPromise = startedInfo ? null : this.createPromise;
      const owned = this.cleanupFailedStart(createPromise, startedInfo);
      this.startupCleanupPromise = owned;
      void owned
        .catch((error: unknown) => {
          this.#logger.error(
            { errorType: errorName(error) },
            'failed to compensate cancelled boson avatar startup',
          );
        })
        .finally(() => {
          if (this.startupCleanupPromise === owned) this.startupCleanupPromise = null;
        });
    }
    return this.startupCleanupPromise;
  }

  private async cleanupFailedStart(
    createPromise: Promise<AvatarSessionInfo> | null,
    sessionInfo: AvatarSessionInfo | null,
  ): Promise<void> {
    try {
      if (!sessionInfo && createPromise) {
        try {
          sessionInfo = await createPromise;
        } catch (error) {
          if (error instanceof AvatarSessionStartError) sessionInfo = error.sessionInfo;
        }
      }
      if (sessionInfo) {
        this.sessionInfo = sessionInfo;
        await this.compensateStart(sessionInfo);
      }
    } finally {
      this.createPromise = null;
      this.detachAgentCloseListener();
      try {
        if (!this.closed) await super.aclose();
      } finally {
        this.closed = true;
      }
    }
  }

  private async runShutdown(): Promise<void> {
    const sessionInfo = this.sessionInfo;
    if (sessionInfo) {
      let deleted = false;
      try {
        await this.api.endSession(sessionInfo.id);
        deleted = true;
      } catch (error) {
        this.#logger.warn(
          { errorType: errorName(error), 'lk.pii.session_id': sessionInfo.id },
          'failed to end boson avatar session',
        );
      }
      if (deleted && this.sessionInfo === sessionInfo) this.sessionInfo = null;
    }
    if (!this.closed) {
      this.detachAgentCloseListener();
      try {
        await super.aclose();
      } finally {
        this.closed = true;
      }
    }
  }

  private async compensateStart(sessionInfo: AvatarSessionInfo): Promise<void> {
    try {
      await this.api.endSession(sessionInfo.id);
    } catch (error) {
      this.#logger.warn(
        { errorType: errorName(error), 'lk.pii.session_id': sessionInfo.id },
        'failed to compensate boson avatar session after startup error',
      );
      return;
    }
    if (this.sessionInfo === sessionInfo) this.sessionInfo = null;
  }

  private onAgentSessionClose = (): void => {
    this.closeRequested = true;
    if ((this.closed && !this.sessionInfo) || this.agentClosePromise) return;
    const owned = this.aclose();
    this.agentClosePromise = owned;
    void owned
      .catch((error: unknown) => {
        this.#logger.error(
          { errorType: errorName(error) },
          'failed to close boson avatar after AgentSession closed',
        );
      })
      .finally(() => {
        if (this.agentClosePromise === owned) this.agentClosePromise = null;
      });
  };

  private detachAgentCloseListener(): void {
    this.trackedAgentSession?.off(voice.AgentSessionEventTypes.Close, this.onAgentSessionClose);
    this.trackedAgentSession = null;
  }

  private async mintAvatarToken({
    room,
    publisherIdentity,
    livekitApiKey,
    livekitApiSecret,
  }: {
    room: Room;
    publisherIdentity: string;
    livekitApiKey: string;
    livekitApiSecret: string;
  }): Promise<string> {
    const ttlSeconds = this.maxDurationMs ? this.maxDurationMs / 1000 + 300 : 4 * 60 * 60;
    const token = new AccessToken(livekitApiKey, livekitApiSecret, {
      identity: this.avatarParticipantIdentity,
      name: this.avatarParticipantName,
      ttl: `${ttlSeconds}s`,
    });
    token.kind = 'agent';
    token.attributes = { [ATTRIBUTE_PUBLISH_ON_BEHALF]: publisherIdentity };
    token.addGrant({
      roomJoin: true,
      room: room.name ?? '',
      canSubscribe: false,
      canPublish: true,
      canPublishData: true,
      canPublishSources: [TrackSource.CAMERA, TrackSource.MICROPHONE],
    } as VideoGrant);
    return token.toJwt();
  }
}

function localParticipantIdentity(room: Room): string {
  const jobIdentity = getJobContext(false)?.agent?.identity?.trim();
  if (jobIdentity) return jobIdentity;
  const roomIdentity = room.isConnected ? room.localParticipant?.identity.trim() : '';
  if (roomIdentity) return roomIdentity;
  throw new BosonAvatarException('failed to get the local LiveKit participant identity');
}

function livekitJobIdempotencyKey(options: {
  livekitUrl: string;
  roomName: string;
  avatarId: string;
  avatarIdentity: string;
  publisherIdentity: string;
  width: number | null;
  height: number | null;
  maxDurationMs: number | null;
}): string | null {
  const jobId = getJobContext(false)?.job.id.trim();
  if (!jobId) return null;
  const intent = JSON.stringify({
    avatar_id: options.avatarId,
    avatar_identity: options.avatarIdentity,
    height: options.height,
    job_id: jobId,
    livekit_url: options.livekitUrl,
    max_duration_seconds: options.maxDurationMs === null ? null : options.maxDurationMs / 1000,
    publisher_identity: options.publisherIdentity,
    room_name: options.roomName,
    width: options.width,
  });
  return uuidV5(`boson-avatar-livekit:${intent}`, UUID_NAMESPACE_URL);
}

function uuidV5(value: string, namespace: string): string {
  const namespaceBytes = Buffer.from(namespace.replaceAll('-', ''), 'hex');
  const bytes = createHash('sha1')
    .update(namespaceBytes)
    .update(value, 'utf8')
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function resolveString(value: string | null | undefined, envName: string): string {
  return (value || process.env[envName] || '').trim();
}

function trimmedOrDefault(value: string | null | undefined, fallback: string): string {
  return value?.trim() || fallback;
}

function positiveInteger(
  value: number | null | undefined,
  name: string,
  maximum?: number,
): number | null {
  if (value == null) return null;
  if (!Number.isInteger(value) || value <= 0) {
    throw new BosonAvatarException(`${name} must be a positive integer`);
  }
  if (maximum !== undefined && value > maximum) {
    throw new BosonAvatarException(`${name} must be between 1 and ${maximum}`);
  }
  return value;
}

function durationMs(value: number | null | undefined): number | null {
  const duration = positiveInteger(value, 'maxDurationMs', MAX_DURATION_MS);
  if (duration !== null && (duration < 1000 || duration % 1000 !== 0)) {
    throw new BosonAvatarException(
      `maxDurationMs must be a whole number of seconds between 1000 and ${MAX_DURATION_MS}`,
    );
  }
  return duration;
}

function validateUuid(value: string | null | undefined): string | null {
  if (value == null) return null;
  if (typeof value !== 'string') {
    throw new BosonAvatarException('idempotencyKey must be a UUID string');
  }
  const normalized = value.trim().toLowerCase();
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized)
  ) {
    throw new BosonAvatarException('idempotencyKey must be a UUID string');
  }
  return normalized;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
