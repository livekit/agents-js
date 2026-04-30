// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { APIConnectOptions } from '@livekit/agents';
import {
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

const DEFAULT_AVATAR_ID = '7d881c1b';
const DEFAULT_API_URL = 'https://api.trugen.ai';
const AVATAR_AGENT_IDENTITY = 'trugen-avatar';
const AVATAR_AGENT_NAME = 'Trugen Avatar';

/**
 * Exception thrown when there are errors with the Trugen API
 * @public
 */
export class TrugenException extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TrugenException';
  }
}

/**
 * Options for configuring an AvatarSession
 * @public
 */
export interface AvatarSessionOptions {
  avatarId?: string | null;
  apiUrl?: string;
  apiKey?: string;
  avatarParticipantIdentity?: string;
  avatarParticipantName?: string;
  connOptions?: APIConnectOptions;
}

/**
 * Options for starting an avatar session.
 * @public
 */
export interface StartOptions {
  livekitUrl?: string;
  livekitApiKey?: string;
  livekitApiSecret?: string;
}

/**
 * Trugen avatar session
 *
 * This class manages the connection between Livekit agent and Trugen avatar,
 * Routing agent audio output to the avatar for visual representation.
 * @public
 */
export class AvatarSession extends voice.AvatarSession {
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
   * @throws TrugenException if TRUGEN_API_KEY is not set
   */
  constructor(options: AvatarSessionOptions = {}) {
    super();
    this.avatarId = options.avatarId || DEFAULT_AVATAR_ID;
    this.apiUrl = options.apiUrl || process.env.TRUGEN_API_URL || DEFAULT_API_URL;
    this.apiKey = options.apiKey || process.env.TRUGEN_API_KEY || '';

    if (!this.apiKey) {
      throw new TrugenException(
        'The api_key must be set either by passing apiKey to the client or ' +
          'by setting the TRUGEN_API_KEY environment variable',
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
   * 1. Creates a Livekit token for the avatar participant
   * 2. Calls the Trugen API to start the avatar session
   * 3. Configures the agent's audio output to stream to the avatar
   *
   * @param agentSession - The agent session to connect the avatar to
   */
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
      throw new TrugenException(
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
        throw new TrugenException(`failed to get local participant identity`);
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
        const response = await fetch(`${this.apiUrl}/v1/sessions`, {
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
        if (e instanceof APIStatusError) {
          this.#logger.warn(
            { statusCode: e.statusCode, body: e.body },
            'failed to call trugen api',
          );
          if (!e.retryable) {
            throw e;
          }
        } else {
          this.#logger.warn({ error: String(e) }, 'failed to call trugen api');
        }
        if (i < this.connOptions.maxRetry) {
          await new Promise((resolve) =>
            setTimeout(resolve, intervalForRetry(this.connOptions, i)),
          );
        }
      }
    }

    throw new APIConnectionError({
      message: 'Failed to start Trugen Avatar session after all retries',
    });
  }
}
