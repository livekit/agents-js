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
import { AccessToken } from 'livekit-server-sdk';
import { ProtofaceAPI, ProtofaceException } from './api.js';
import { log } from './log.js';

/** @public */
export const DEFAULT_STOCK_AVATAR_ID = 'av_stock_001';

const ATTRIBUTE_PUBLISH_ON_BEHALF = 'lk.publish_on_behalf';
const SAMPLE_RATE = 16000;
const AVATAR_AGENT_IDENTITY = 'protoface-avatar-agent';
const AVATAR_AGENT_NAME = 'protoface-avatar-agent';

/** @public */
export interface AvatarSessionOptions {
  /** Protoface avatar ID to render. Defaults to the stable stock avatar ID `av_stock_001`. */
  avatarId?: string;
  /** Override the Protoface API base URL. */
  apiUrl?: string | null;
  /** Protoface API key. Falls back to the `PROTOFACE_API_KEY` env var. */
  apiKey?: string | null;
  /** Optional maximum session duration in milliseconds. */
  maxDurationMs?: number | null;
  /** Identity for the avatar participant. Defaults to `protoface-avatar-agent`. */
  avatarParticipantIdentity?: string | null;
  /** Display name for the avatar participant. Defaults to `protoface-avatar-agent`. */
  avatarParticipantName?: string | null;
  /** API retry/timeout options. */
  connOptions?: APIConnectOptions;
}

/**
 * Optional LiveKit credentials for {@link AvatarSession.start}; falls back to env vars.
 *
 * @public
 */
export interface StartOptions {
  livekitUrl?: string | null;
  livekitApiKey?: string | null;
  livekitApiSecret?: string | null;
}

/**
 * A Protoface avatar session for LiveKit Agents.
 *
 * @public
 */
export class AvatarSession extends voice.AvatarSession {
  private avatarId: string;
  private maxDurationMs?: number | null;
  private avatarParticipantIdentity: string;
  private avatarParticipantName: string;
  private api: ProtofaceAPI;
  private sessionIdValue: string | null = null;

  #logger = log();

  constructor(options: AvatarSessionOptions = {}) {
    super();
    this.avatarId = options.avatarId ?? DEFAULT_STOCK_AVATAR_ID;
    this.maxDurationMs = options.maxDurationMs;
    this.avatarParticipantIdentity = options.avatarParticipantIdentity || AVATAR_AGENT_IDENTITY;
    this.avatarParticipantName = options.avatarParticipantName || AVATAR_AGENT_NAME;
    this.api = new ProtofaceAPI({
      apiKey: options.apiKey,
      apiUrl: options.apiUrl,
      connOptions: options.connOptions ?? DEFAULT_API_CONNECT_OPTIONS,
    });
  }

  override get avatarIdentity(): string {
    return this.avatarParticipantIdentity;
  }

  override get provider(): string {
    return 'protoface';
  }

  /** Protoface session ID after `start()` succeeds, otherwise `null`. */
  get sessionId(): string | null {
    return this.sessionIdValue;
  }

  async start(
    agentSession: voice.AgentSession,
    room: Room,
    options: StartOptions = {},
  ): Promise<void> {
    if (this.sessionIdValue !== null) {
      throw new Error('AvatarSession.start() called twice; create a new AvatarSession.');
    }

    await super.start(agentSession, room);

    const livekitUrl = options.livekitUrl ?? process.env.LIVEKIT_URL;
    const livekitApiKey = options.livekitApiKey ?? process.env.LIVEKIT_API_KEY;
    const livekitApiSecret = options.livekitApiSecret ?? process.env.LIVEKIT_API_SECRET;
    if (!livekitUrl || !livekitApiKey || !livekitApiSecret) {
      throw new ProtofaceException(
        'livekitUrl, livekitApiKey, and livekitApiSecret must be set by arguments or environment variables',
      );
    }

    const workerToken = await this.mintWorkerToken({ room, livekitApiKey, livekitApiSecret });
    const session = await this.api.startSession({
      avatarId: this.avatarId,
      transport: {
        type: 'livekit',
        url: livekitUrl,
        room_name: room.name,
        worker_token: workerToken,
        worker_identity: this.avatarParticipantIdentity,
        audio_source: 'data_stream',
      },
      maxDurationMs: this.maxDurationMs,
    });

    if (typeof session.id !== 'string') {
      throw new ProtofaceException('Protoface API response missing session id');
    }

    this.sessionIdValue = session.id;
    this.#logger.debug(
      { sessionId: this.sessionIdValue, avatarId: this.avatarId },
      'protoface session started',
    );

    agentSession.output.audio = new voice.DataStreamAudioOutput({
      room,
      destinationIdentity: this.avatarParticipantIdentity,
      sampleRate: SAMPLE_RATE,
      waitRemoteTrack: TrackKind.KIND_VIDEO,
    });
  }

  async aclose(): Promise<void> {
    const sessionId = this.sessionIdValue;
    this.sessionIdValue = null;
    try {
      if (sessionId !== null) {
        try {
          await this.api.endSession(sessionId);
        } catch (error) {
          this.#logger.warn(
            { 'lk.pii.error': error, sessionId },
            'failed to end protoface session',
          );
        }
      }
    } finally {
      await super.aclose();
    }
  }

  private async mintWorkerToken({
    room,
    livekitApiKey,
    livekitApiSecret,
  }: {
    room: Room;
    livekitApiKey: string;
    livekitApiSecret: string;
  }): Promise<string> {
    let localParticipantIdentity = '';
    try {
      const jobCtx = getJobContext();
      localParticipantIdentity = jobCtx.agent?.identity || '';
    } catch {
      // Fall back to the connected room below when no job context is available.
    }

    if (!localParticipantIdentity && room.isConnected && room.localParticipant) {
      localParticipantIdentity = room.localParticipant.identity;
    }

    if (!localParticipantIdentity) {
      throw new ProtofaceException('failed to get local participant identity');
    }

    const token = new AccessToken(livekitApiKey, livekitApiSecret, {
      identity: this.avatarParticipantIdentity,
      name: this.avatarParticipantName,
    });
    token.kind = 'agent';
    token.attributes = { [ATTRIBUTE_PUBLISH_ON_BEHALF]: localParticipantIdentity };
    token.addGrant({
      roomJoin: true,
      room: room.name,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    } as VideoGrant);

    return token.toJwt();
  }
}
