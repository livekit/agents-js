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
import { TavusAPI, TavusException } from './api.js';
import { log } from './log.js';

const ATTRIBUTE_PUBLISH_ON_BEHALF = 'lk.publish_on_behalf';
const SAMPLE_RATE = 24000;
const AVATAR_AGENT_IDENTITY = 'tavus-avatar-agent';
const AVATAR_AGENT_NAME = 'tavus-avatar-agent';

/**
 * Options for configuring an AvatarSession.
 *
 * @public
 */
export interface AvatarSessionOptions {
  /** Tavus face id. Falls back to `TAVUS_FACE_ID`. */
  faceId?: string;
  /** Tavus pal id. Falls back to `TAVUS_PAL_ID`; defaults to a stock pal when omitted. */
  palId?: string;
  /** @deprecated Use {@link AvatarSessionOptions.faceId | faceId} instead. */
  replicaId?: string;
  /** @deprecated Use {@link AvatarSessionOptions.palId | palId} instead. */
  personaId?: string;
  /** Override the Tavus API base URL. */
  apiUrl?: string;
  /** Tavus API key. Falls back to `TAVUS_API_KEY`. */
  apiKey?: string;
  /** Identity for the avatar participant. Defaults to `tavus-avatar-agent`. */
  avatarParticipantIdentity?: string;
  /** Display name for the avatar participant. Defaults to `tavus-avatar-agent`. */
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
 * A Tavus avatar session.
 *
 * @public
 */
export class AvatarSession extends voice.AvatarSession {
  private faceId?: string;
  private palId?: string;
  // Deprecated aliases for faceId/palId; resolved in TavusAPI.createConversation.
  private replicaId?: string;
  private personaId?: string;
  private avatarParticipantIdentity: string;
  private avatarParticipantName: string;
  private api: TavusAPI;

  conversationId: string | null = null;

  #logger = log();

  constructor(options: AvatarSessionOptions = {}) {
    super();
    this.faceId = options.faceId;
    this.palId = options.palId;
    this.replicaId = options.replicaId;
    this.personaId = options.personaId;
    this.avatarParticipantIdentity = options.avatarParticipantIdentity || AVATAR_AGENT_IDENTITY;
    this.avatarParticipantName = options.avatarParticipantName || AVATAR_AGENT_NAME;
    this.api = new TavusAPI({
      apiUrl: options.apiUrl,
      apiKey: options.apiKey,
      connOptions: options.connOptions || DEFAULT_API_CONNECT_OPTIONS,
    });
  }

  get avatarIdentity(): string {
    return this.avatarParticipantIdentity;
  }

  override get provider(): string {
    return 'tavus';
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
      throw new TavusException(
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
        throw new TavusException('failed to get local participant identity');
      }
      localParticipantIdentity = room.localParticipant.identity;
    }

    if (!localParticipantIdentity) {
      throw new TavusException('failed to get local participant identity');
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

    this.#logger.debug('starting avatar session');
    this.conversationId = await this.api.createConversation({
      faceId: this.faceId,
      palId: this.palId,
      replicaId: this.replicaId,
      personaId: this.personaId,
      properties: { livekit_ws_url: livekitUrl, livekit_room_token: livekitToken },
    });

    agentSession.output.replaceAudioTail(
      new voice.DataStreamAudioOutput({
        room,
        destinationIdentity: this.avatarIdentity,
        sampleRate: SAMPLE_RATE,
        waitRemoteTrack: TrackKind.KIND_VIDEO,
      }),
    );
  }
}
