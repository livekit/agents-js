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
import { DIDAPI, DIDException } from './api.js';
import { log } from './log.js';
import { type AudioConfig, DEFAULT_SAMPLE_RATE } from './types.js';

const ATTRIBUTE_PUBLISH_ON_BEHALF = 'lk.publish_on_behalf';
const AVATAR_AGENT_IDENTITY = 'd-id-avatar-agent';
const AVATAR_AGENT_NAME = 'd-id-avatar-agent';

/**
 * Options for configuring an AvatarSession.
 *
 * @public
 */
export interface AvatarSessionOptions {
  /** D-ID agent id. Required. See the plugin README for how to create one. */
  agentId: string;
  /** Override the D-ID API base URL. */
  apiUrl?: string;
  /** D-ID API key. Falls back to `DID_API_KEY`. */
  apiKey?: string;
  /** Audio configuration for the stream sent to the D-ID avatar. */
  audioConfig?: AudioConfig;
  /** Identity for the avatar participant. Defaults to `d-id-avatar-agent`. */
  avatarParticipantIdentity?: string;
  /** Display name for the avatar participant. Defaults to `d-id-avatar-agent`. */
  avatarParticipantName?: string;
  /** API retry/timeout options. */
  connOptions?: APIConnectOptions;
}

/**
 * Optional LiveKit credentials for {@link AvatarSession.start}; falls back to env vars.
 *
 * @public
 */
export interface StartOptions {
  /** LiveKit server URL. Falls back to `LIVEKIT_URL`. */
  livekitUrl?: string;
  /** LiveKit API key. Falls back to `LIVEKIT_API_KEY`. */
  livekitApiKey?: string;
  /** LiveKit API secret. Falls back to `LIVEKIT_API_SECRET`. */
  livekitApiSecret?: string;
}

/**
 * A D-ID avatar session.
 *
 * @public
 */
export class AvatarSession extends voice.AvatarSession {
  private agentId: string;
  private audioConfig: AudioConfig;
  private avatarParticipantIdentity: string;
  private avatarParticipantName: string;
  private api: DIDAPI;

  sessionId: string | null = null;

  #logger = log();

  constructor(options: AvatarSessionOptions) {
    super();
    if (!options.agentId) {
      throw new DIDException('agentId is required');
    }
    this.agentId = options.agentId;
    this.audioConfig = options.audioConfig ?? {};
    this.avatarParticipantIdentity = options.avatarParticipantIdentity || AVATAR_AGENT_IDENTITY;
    this.avatarParticipantName = options.avatarParticipantName || AVATAR_AGENT_NAME;
    this.api = new DIDAPI({
      apiUrl: options.apiUrl,
      apiKey: options.apiKey,
      connOptions: options.connOptions || DEFAULT_API_CONNECT_OPTIONS,
    });
  }

  override get avatarIdentity(): string {
    return this.avatarParticipantIdentity;
  }

  override get provider(): string {
    return 'd-id';
  }

  async start(
    agentSession: voice.AgentSession,
    room: Room,
    options: StartOptions = {},
  ): Promise<void> {
    await super.start(agentSession, room);

    const livekitUrl = options.livekitUrl || process.env.LIVEKIT_URL;
    const livekitApiKey = options.livekitApiKey || process.env.LIVEKIT_API_KEY;
    const livekitApiSecret = options.livekitApiSecret || process.env.LIVEKIT_API_SECRET;
    if (!livekitUrl || !livekitApiKey || !livekitApiSecret) {
      throw new DIDException(
        'livekitUrl, livekitApiKey, and livekitApiSecret must be set ' +
          'by arguments or environment variables',
      );
    }

    let localParticipantIdentity: string;
    try {
      const jobCtx = getJobContext();
      localParticipantIdentity = jobCtx.agent?.identity || '';
      if (!localParticipantIdentity && room.localParticipant) {
        localParticipantIdentity = room.localParticipant.identity;
      }
    } catch {
      if (!room.isConnected || !room.localParticipant) {
        throw new DIDException('failed to get local participant identity');
      }
      localParticipantIdentity = room.localParticipant.identity;
    }

    if (!localParticipantIdentity) {
      throw new DIDException('failed to get local participant identity');
    }

    const at = new AccessToken(livekitApiKey, livekitApiSecret, {
      identity: this.avatarIdentity,
      name: this.avatarParticipantName,
    });
    at.kind = 'agent';
    at.addGrant({
      roomJoin: true,
      room: room.name,
    } as VideoGrant);
    at.attributes = {
      [ATTRIBUTE_PUBLISH_ON_BEHALF]: localParticipantIdentity,
    };

    const livekitToken = await at.toJwt();

    const sampleRate = this.audioConfig.sampleRate ?? DEFAULT_SAMPLE_RATE;

    this.#logger.debug('starting avatar session');
    this.sessionId = await this.api.joinSession({
      agentId: this.agentId,
      transport: {
        provider: 'livekit',
        server_url: livekitUrl,
        token: livekitToken,
        room_name: room.name!,
      },
      audioConfig: { sample_rate: sampleRate },
    });

    agentSession.output.audio = new voice.DataStreamAudioOutput({
      room,
      destinationIdentity: this.avatarIdentity,
      sampleRate,
      waitRemoteTrack: TrackKind.KIND_VIDEO,
    });
  }
}
