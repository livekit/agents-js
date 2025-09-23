// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { log, voice } from '@livekit/agents';
import type { Room } from '@livekit/rtc-node';
import { TrackKind } from '@livekit/rtc-node';
import { AccessToken, type VideoGrant } from 'livekit-server-sdk';
import { AnamAPI } from './api.js';
import { type APIConnectOptions, AnamException, type PersonaConfig } from './types.js';

export async function mintAvatarJoinToken({
  roomName,
  avatarIdentity,
  publishOnBehalf,
  apiKey = process.env.LIVEKIT_API_KEY!,
  apiSecret = process.env.LIVEKIT_API_SECRET!,
  ttl = '60s',
}: {
  roomName: string;
  avatarIdentity: string;
  publishOnBehalf: string;
  apiKey?: string;
  apiSecret?: string;
  ttl?: string | number;
}): Promise<string> {
  const at = new AccessToken(apiKey, apiSecret);
  at.identity = avatarIdentity;
  at.name = 'Anam Avatar';
  at.kind = 'agent';
  at.ttl = ttl;
  at.attributes = { 'lk.publish_on_behalf': publishOnBehalf };

  at.addGrant({ roomJoin: true, room: roomName } as VideoGrant);
  return at.toJwt();
}

const AVATAR_IDENTITY = 'anam-avatar-agent';
const _AVATAR_NAME = 'anam-avatar-agent';

export class AvatarSession {
  private sessionId?: string;

  constructor(
    private opts: {
      personaConfig: PersonaConfig;
      apiUrl?: string;
      apiKey?: string;
      avatarParticipantIdentity?: string;
      avatarParticipantName?: string;
      connOptions?: APIConnectOptions;
    },
  ) {}

  async start(
    agentSession: voice.AgentSession,
    room: Room,
    params?: {
      livekitUrl?: string;
      livekitApiKey?: string;
      livekitApiSecret?: string;
    },
  ) {
    const logger = log().child({ module: 'AnamAvatar' });
    const apiKey = this.opts.apiKey ?? process.env.ANAM_API_KEY;
    if (!apiKey) throw new AnamException('ANAM_API_KEY is required');

    const apiUrl = this.opts.apiUrl ?? process.env.ANAM_API_URL;
    const livekitUrl = params?.livekitUrl ?? process.env.LIVEKIT_URL;
    const lkKey = params?.livekitApiKey ?? process.env.LIVEKIT_API_KEY;
    const lkSecret = params?.livekitApiSecret ?? process.env.LIVEKIT_API_SECRET;

    if (!livekitUrl || !lkKey || !lkSecret) {
      throw new AnamException('LIVEKIT_URL/API_KEY/API_SECRET must be set');
    }

    const localIdentity = (room.localParticipant && room.localParticipant.identity) || 'agent';

    logger.debug(
      {
        personaName: this.opts.personaConfig?.name,
        avatarId: this.opts.personaConfig?.avatarId,
        apiUrl: apiUrl ?? '(default https://api.anam.ai)',
        livekitUrl,
        avatarParticipantIdentity: this.opts.avatarParticipantIdentity ?? 'anam-avatar-agent',
        publishOnBehalf: localIdentity,
      },
      'starting Anam avatar session',
    );

    const jwt = await mintAvatarJoinToken({
      roomName: room.name!,
      avatarIdentity: this.opts.avatarParticipantIdentity ?? AVATAR_IDENTITY,
      publishOnBehalf: localIdentity,
      apiKey: lkKey,
      apiSecret: lkSecret,
    });

    const anam = new AnamAPI(apiKey, apiUrl, this.opts.connOptions);
    logger.debug({ livekitUrl }, 'requesting Anam session token');

    const { sessionToken } = await anam.createSessionToken({
      personaConfig: {
        name: this.opts.personaConfig?.name,
        avatarId: this.opts.personaConfig?.avatarId,
      },
      livekitUrl,
      livekitToken: jwt,
    });
    logger.debug('starting Anam engine session');
    const started = await anam.startEngineSession({ sessionToken });
    this.sessionId = started.sessionId;

    agentSession.output.audio = new voice.DataStreamAudioOutput({
      room,
      destinationIdentity: this.opts.avatarParticipantIdentity ?? AVATAR_IDENTITY,
      waitRemoteTrack: TrackKind.KIND_VIDEO,
    });
  }
}
