// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type APIConnectOptions,
  APIConnectionError,
  APIStatusError,
  DEFAULT_API_CONNECT_OPTIONS,
  intervalForRetry,
  voice,
} from '@livekit/agents';
import type { Room } from '@livekit/rtc-node';
import { TrackKind } from '@livekit/rtc-node';
import type { VideoGrant } from 'livekit-server-sdk';
import { AccessToken } from 'livekit-server-sdk';
import { log } from './log.js';

const ATTRIBUTE_PUBLISH_ON_BEHALF = 'lk.publish_on_behalf';

const DEFAULT_API_URL = 'https://api.runwayml.com';
const API_VERSION = '2024-11-06';
const SAMPLE_RATE = 16000;
const AVATAR_AGENT_IDENTITY = 'runway-avatar-agent';
const AVATAR_AGENT_NAME = 'runway-avatar-agent';
const USER_AGENT = `${__PACKAGE_NAME__}/${__PACKAGE_VERSION__}`;

export class RunwayException extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunwayException';
  }
}

export interface AvatarSessionOptions {
  /**
   * ID of a user-created avatar. Provide either avatarId or presetId, not both.
   */
  avatarId?: string;
  /**
   * ID of a Runway preset avatar. Provide either avatarId or presetId, not both.
   */
  presetId?: string;
  /**
   * Maximum session duration in seconds.
   */
  maxDuration?: number;
  /**
   * Runway API secret. Falls back to RUNWAYML_API_SECRET environment variable.
   */
  apiKey?: string;
  /**
   * Runway API URL. Defaults to https://api.runwayml.com or RUNWAYML_BASE_URL environment variable.
   */
  apiUrl?: string;
  avatarParticipantIdentity?: string;
  avatarParticipantName?: string;
  connOptions?: APIConnectOptions;
}

export interface StartOptions {
  livekitUrl?: string;
  livekitApiKey?: string;
  livekitApiSecret?: string;
}

export class AvatarSession {
  private avatar: Record<string, string>;
  private maxDuration?: number;
  private apiUrl: string;
  private apiKey: string;
  private avatarParticipantIdentity: string;
  private avatarParticipantName: string;
  private connOptions: APIConnectOptions;

  #logger = log();

  constructor(options: AvatarSessionOptions = {}) {
    if (!options.avatarId && !options.presetId) {
      throw new RunwayException('Either avatarId or presetId must be provided');
    }
    if (options.avatarId && options.presetId) {
      throw new RunwayException('Provide avatarId or presetId, not both');
    }

    this.avatar = options.avatarId
      ? { type: 'custom', avatarId: options.avatarId }
      : { type: 'runway-preset', presetId: options.presetId! };
    this.maxDuration = options.maxDuration;

    this.apiUrl = options.apiUrl || process.env.RUNWAYML_BASE_URL || DEFAULT_API_URL;
    this.apiKey = options.apiKey || process.env.RUNWAYML_API_SECRET || '';

    if (!this.apiKey) {
      throw new RunwayException(
        'apiKey must be provided or set via the RUNWAYML_API_SECRET environment variable',
      );
    }

    this.avatarParticipantIdentity =
      options.avatarParticipantIdentity || AVATAR_AGENT_IDENTITY;
    this.avatarParticipantName = options.avatarParticipantName || AVATAR_AGENT_NAME;
    this.connOptions = options.connOptions || DEFAULT_API_CONNECT_OPTIONS;
  }

  async start(
    agentSession: voice.AgentSession,
    room: Room,
    options: StartOptions = {},
  ): Promise<void> {
    const livekitUrl = options.livekitUrl || process.env.LIVEKIT_URL;
    const livekitApiKey = options.livekitApiKey || process.env.LIVEKIT_API_KEY;
    const livekitApiSecret = options.livekitApiSecret || process.env.LIVEKIT_API_SECRET;

    if (!livekitUrl || !livekitApiKey || !livekitApiSecret) {
      throw new RunwayException(
        'livekitUrl, livekitApiKey, and livekitApiSecret must be set ' +
          'by arguments or environment variables',
      );
    }

    if (!room.isConnected || !room.localParticipant) {
      throw new RunwayException(
        'room must be connected before starting the avatar session — call ctx.connect() first',
      );
    }
    const localParticipantIdentity = room.localParticipant.identity;

    const at = new AccessToken(livekitApiKey, livekitApiSecret, {
      identity: this.avatarParticipantIdentity,
      name: this.avatarParticipantName,
    });
    at.kind = 'agent';
    at.addGrant({ roomJoin: true, room: room.name } as VideoGrant);
    at.attributes = { [ATTRIBUTE_PUBLISH_ON_BEHALF]: localParticipantIdentity };

    const livekitToken = await at.toJwt();

    this.#logger.debug('starting Runway avatar session');
    await this.createSession(livekitUrl, livekitToken, room.name || '', localParticipantIdentity);

    agentSession.output.audio = new voice.DataStreamAudioOutput({
      room,
      destinationIdentity: this.avatarParticipantIdentity,
      waitRemoteTrack: TrackKind.KIND_VIDEO,
      sampleRate: SAMPLE_RATE,
    });
  }

  private async createSession(
    livekitUrl: string,
    livekitToken: string,
    roomName: string,
    agentIdentity: string,
  ): Promise<void> {
    const body: Record<string, unknown> = {
      model: 'gwm1_avatars',
      avatar: this.avatar,
      livekit: {
        url: livekitUrl,
        token: livekitToken,
        roomName,
        agentIdentity,
      },
    };

    if (this.maxDuration !== undefined) {
      body.maxDuration = this.maxDuration;
    }

    const maxAttempts = this.connOptions.maxRetry + 1;
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const response = await fetch(`${this.apiUrl}/v1/realtime_sessions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'X-Runway-Version': API_VERSION,
            'Content-Type': 'application/json',
            'User-Agent': USER_AGENT,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.connOptions.timeoutMs),
        });

        if (!response.ok) {
          const text = await response.text();
          throw new APIStatusError({
            message: 'Runway API returned an error',
            options: { statusCode: response.status, body: { error: text } },
          });
        }
        return;
      } catch (e) {
        if (e instanceof APIStatusError && !e.retryable) throw e;

        if (e instanceof APIConnectionError) {
          this.#logger.warn({ error: String(e) }, 'failed to call Runway API');
        } else {
          this.#logger.error({ error: e }, 'failed to call Runway API');
        }

        if (i < maxAttempts - 1) {
          await new Promise((resolve) =>
            setTimeout(resolve, intervalForRetry(this.connOptions, i)),
          );
        }
      }
    }

    throw new APIConnectionError({
      message: 'Failed to start Runway avatar session after all retries',
    });
  }
}
