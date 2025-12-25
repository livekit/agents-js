// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type APIConnectOptions,
  APIConnectionError,
  APIStatusError,
  DEFAULT_API_CONNECT_OPTIONS,
  getJobContext,
  intervalForRetry,
  voice,
} from '@livekit/agents';
import type { Room } from '@livekit/rtc-node';
import { TrackKind } from '@livekit/rtc-node';
import type { VideoGrant } from 'livekit-server-sdk';
import { AccessToken } from 'livekit-server-sdk';
import { log } from './log.js';

const ATTRIBUTE_PUBLISH_ON_BEHALF = 'lk.publish_on_behalf';

const STOCK_AVATAR_ID = '694c83e2-8895-4a98-bd16-56332ca3f449';
const DEFAULT_API_URL = 'https://api.bey.dev';
const AVATAR_AGENT_IDENTITY = 'bey-avatar-agent';
const AVATAR_AGENT_NAME = 'bey-avatar-agent';

/**
 * Exception thrown when there are errors with the Beyond Presence API.
 */
export class BeyException extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BeyException';
  }
}

/**
 * Options for configuring an AvatarSession.
 */
export interface AvatarSessionOptions {
  /**
   * The avatar ID to use. If not provided, defaults to a stock avatar.
   */
  avatarId?: string | null;
  /**
   * The Beyond Presence API URL. Defaults to https://api.bey.dev or BEY_API_URL environment variable.
   */
  apiUrl?: string;
  /**
   * The Beyond Presence API key. Can also be set via BEY_API_KEY environment variable.
   */
  apiKey?: string;
  /**
   * The identity of the avatar participant in the room. Defaults to 'bey-avatar-agent'.
   */
  avatarParticipantIdentity?: string;
  /**
   * The name of the avatar participant in the room. Defaults to 'bey-avatar-agent'.
   */
  avatarParticipantName?: string;
  /**
   * Connection options for API requests.
   */
  connOptions?: APIConnectOptions;
}

/**
 * Options for starting an avatar session.
 */
export interface StartOptions {
  /**
   * LiveKit server URL. Falls back to LIVEKIT_URL environment variable.
   */
  livekitUrl?: string;
  /**
   * LiveKit API key. Falls back to LIVEKIT_API_KEY environment variable.
   */
  livekitApiKey?: string;
  /**
   * LiveKit API secret. Falls back to LIVEKIT_API_SECRET environment variable.
   */
  livekitApiSecret?: string;
}

/**
 * A Beyond Presence avatar session.
 *
 * This class manages the connection between a LiveKit agent and a Beyond Presence avatar,
 * routing agent audio output to the avatar for visual representation.
 *
 * @example
 * ```typescript
 * const avatar = new AvatarSession({
 *   avatarId: 'your-avatar-id',
 *   apiKey: 'your-bey-api-key',
 * });
 * await avatar.start(agentSession, room);
 * ```
 */
export class AvatarSession {
  private avatarId: string;
  private apiUrl: string;
  private apiKey: string;
  private avatarParticipantIdentity: string;
  private avatarParticipantName: string;
  private connOptions: APIConnectOptions;

  #logger = log();

  /**
   * Creates a new AvatarSession.
   *
   * @param options - Configuration options for the avatar session
   * @throws BeyException if BEY_API_KEY is not set
   */
  constructor(options: AvatarSessionOptions = {}) {
    this.avatarId = options.avatarId || STOCK_AVATAR_ID;
    this.apiUrl = options.apiUrl || process.env.BEY_API_URL || DEFAULT_API_URL;
    this.apiKey = options.apiKey || process.env.BEY_API_KEY || '';

    if (!this.apiKey) {
      throw new BeyException(
        'The api_key must be set either by passing apiKey to the client or ' +
          'by setting the BEY_API_KEY environment variable',
      );
    }

    this.avatarParticipantIdentity = options.avatarParticipantIdentity || AVATAR_AGENT_IDENTITY;
    this.avatarParticipantName = options.avatarParticipantName || AVATAR_AGENT_NAME;
    this.connOptions = options.connOptions || DEFAULT_API_CONNECT_OPTIONS;
  }

  /**
   * Starts the avatar session and connects it to the agent.
   *
   * This method:
   * 1. Creates a LiveKit token for the avatar participant
   * 2. Calls the Beyond Presence API to start the avatar session
   * 3. Configures the agent's audio output to stream to the avatar
   *
   * @param agentSession - The agent session to connect to the avatar
   * @param room - The LiveKit room where the avatar will join
   * @param options - Optional LiveKit credentials (falls back to environment variables)
   * @throws BeyException if LiveKit credentials are not available or if the avatar session fails to start
   */
  async start(
    agentSession: voice.AgentSession,
    room: Room,
    options: StartOptions = {},
  ): Promise<void> {
    const livekitUrl = options.livekitUrl || process.env.LIVEKIT_URL;
    const livekitApiKey = options.livekitApiKey || process.env.LIVEKIT_API_KEY;
    const livekitApiSecret = options.livekitApiSecret || process.env.LIVEKIT_API_SECRET;

    if (!livekitUrl || !livekitApiKey || !livekitApiSecret) {
      throw new BeyException(
        'livekitUrl, livekitApiKey, and livekitApiSecret must be set ' +
          'by arguments or environment variables',
      );
    }

    let localParticipantIdentity: string;
    try {
      const jobCtx = getJobContext();
      localParticipantIdentity = jobCtx.job.participant?.identity || '';
      if (!localParticipantIdentity && room.localParticipant) {
        localParticipantIdentity = room.localParticipant.identity;
      }
    } catch (e) {
      if (!room.isConnected || !room.localParticipant) {
        throw new BeyException('failed to get local participant identity');
      }
      localParticipantIdentity = room.localParticipant.identity;
    }

    const at = new AccessToken(livekitApiKey, livekitApiSecret, {
      identity: this.avatarParticipantIdentity,
      name: this.avatarParticipantName,
    });
    at.kind = 'agent';

    at.addGrant({
      roomJoin: true,
      room: room.name,
    } as VideoGrant);

    // allow the avatar agent to publish audio and video on behalf of your local agent
    at.attributes = {
      [ATTRIBUTE_PUBLISH_ON_BEHALF]: localParticipantIdentity,
    };

    const livekitToken = await at.toJwt();

    this.#logger.debug('starting avatar session');
    await this.startAgent(livekitUrl, livekitToken);

    agentSession.output.audio = new voice.DataStreamAudioOutput({
      room,
      destinationIdentity: this.avatarParticipantIdentity,
      waitRemoteTrack: TrackKind.KIND_VIDEO,
    });
  }

  private async startAgent(livekitUrl: string, livekitToken: string): Promise<void> {
    for (let i = 0; i < this.connOptions.maxRetry; i++) {
      try {
        const response = await fetch(`${this.apiUrl}/v1/session`, {
          method: 'POST',
          headers: {
            'x-api-key': this.apiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            avatar_id: this.avatarId,
            livekit_url: livekitUrl,
            livekit_token: livekitToken,
          }),
          signal: AbortSignal.timeout(this.connOptions.timeoutMs),
        });

        if (!response.ok) {
          const text = await response.text();
          throw new APIStatusError({
            message: 'Server returned an error',
            options: { statusCode: response.status, body: { error: text } },
          });
        }
        return;
      } catch (e) {
        if (e instanceof APIConnectionError) {
          this.#logger.warn({ error: String(e) }, 'failed to call bey presence api');
        } else {
          this.#logger.error({ error: e }, 'failed to call bey presence api');
        }

        if (i < this.connOptions.maxRetry - 1) {
          await new Promise((resolve) =>
            setTimeout(resolve, intervalForRetry(this.connOptions, i)),
          );
        }
      }
    }

    throw new APIConnectionError({
      message: 'Failed to start Bey Avatar Session after all retries',
    });
  }
}
