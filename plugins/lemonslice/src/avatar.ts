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
const DEFAULT_API_URL = 'https://lemonslice.com/api/liveai/sessions';
const SAMPLE_RATE = 16000;
const AVATAR_AGENT_IDENTITY = 'lemonslice-avatar-agent';
const AVATAR_AGENT_NAME = 'lemonslice-avatar-agent';

/**
 * Exception thrown when there are errors with the LemonSlice API.
 */
export class LemonSliceException extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LemonSliceException';
  }
}

/**
 * Options for configuring an AvatarSession.
 */
export interface AvatarSessionOptions {
  /**
   * The ID of the LemonSlice agent to add to the session.
   * Either agentId or agentImageUrl must be provided.
   */
  agentId?: string | null;
  /**
   * The URL of the image to use as the agent's avatar.
   * Either agentId or agentImageUrl must be provided.
   */
  agentImageUrl?: string | null;
  /**
   * A prompt that subtly influences the avatar's movements and expressions.
   */
  agentPrompt?: string | null;
  /**
   * The idle timeout, in seconds. Defaults to 60 seconds.
   */
  idleTimeout?: number | null;
  /**
   * The LemonSlice API URL. Defaults to https://lemonslice.com/api/liveai/sessions
   * or LEMONSLICE_API_URL environment variable.
   */
  apiUrl?: string;
  /**
   * The LemonSlice API key. Can also be set via LEMONSLICE_API_KEY environment variable.
   */
  apiKey?: string;
  /**
   * The identity of the avatar participant in the room. Defaults to 'lemonslice-avatar-agent'.
   */
  avatarParticipantIdentity?: string;
  /**
   * The name of the avatar participant in the room. Defaults to 'lemonslice-avatar-agent'.
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
 * A LemonSlice avatar session.
 *
 * This class manages the connection between a LiveKit agent and a LemonSlice avatar,
 * routing agent audio output to the avatar for visual representation.
 *
 * @example
 * ```typescript
 * // Using an agent ID
 * const avatar = new AvatarSession({
 *   agentId: 'your-agent-id',
 *   apiKey: 'your-lemonslice-api-key',
 * });
 * await avatar.start(agentSession, room);
 *
 * // Using a custom avatar image
 * const avatar = new AvatarSession({
 *   agentImageUrl: 'your-image-url',
 *   apiKey: 'your-lemonslice-api-key',
 * });
 * await avatar.start(agentSession, room);
 * ```
 */
export class AvatarSession {
  private agentId: string | null;
  private agentImageUrl: string | null;
  private agentPrompt: string | null;
  private idleTimeout: number | null;
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
   * @throws LemonSliceException if invalid agentId or agentImageUrl is provided, or if LemonSlice API key is not set
   */
  constructor(options: AvatarSessionOptions = {}) {
    this.agentId = options.agentId ?? null;
    this.agentImageUrl = options.agentImageUrl ?? null;

    if (!this.agentId && !this.agentImageUrl) {
      throw new LemonSliceException('Missing agentId or agentImageUrl');
    }
    if (this.agentId && this.agentImageUrl) {
      throw new LemonSliceException('Only one of agentId or agentImageUrl can be provided');
    }

    this.agentPrompt = options.agentPrompt ?? null;
    this.idleTimeout = options.idleTimeout ?? null;

    this.apiUrl = options.apiUrl || process.env.LEMONSLICE_API_URL || DEFAULT_API_URL;
    this.apiKey = options.apiKey || process.env.LEMONSLICE_API_KEY || '';

    if (!this.apiKey) {
      throw new LemonSliceException(
        'The api_key must be set either by passing apiKey to the client or ' +
          'by setting the LEMONSLICE_API_KEY environment variable',
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
   * 2. Calls the LemonSlice API to start the avatar session
   * 3. Configures the agent's audio output to stream to the avatar
   *
   * @param agentSession - The agent session to connect to the avatar
   * @param room - The LiveKit room where the avatar will join
   * @param options - Optional LiveKit credentials (falls back to environment variables)
   * @throws LemonSliceException if LiveKit credentials are not available or if the avatar session fails to start
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
      throw new LemonSliceException(
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
        throw new LemonSliceException('failed to get local participant identity');
      }
      localParticipantIdentity = room.localParticipant.identity;
    }

    if (!localParticipantIdentity) {
      throw new LemonSliceException('failed to get local participant identity');
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
      sampleRate: SAMPLE_RATE,
      waitRemoteTrack: TrackKind.KIND_VIDEO,
    });
  }

  private async startAgent(livekitUrl: string, livekitToken: string): Promise<void> {
    for (let i = 0; i <= this.connOptions.maxRetry; i++) {
      try {
        const payload: Record<string, any> = {
          transport_type: 'livekit',
          properties: {
            livekit_url: livekitUrl,
            livekit_token: livekitToken,
          },
        };

        if (this.agentId) {
          payload.agent_id = this.agentId;
        }

        if (this.agentImageUrl) {
          payload.agent_image_url = this.agentImageUrl;
        }

        if (this.agentPrompt) {
          payload.agent_prompt = this.agentPrompt;
        }

        if (this.idleTimeout !== null) {
          payload.idle_timeout = this.idleTimeout;
        }

        const response = await fetch(this.apiUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-API-Key': this.apiKey,
          },
          body: JSON.stringify(payload),
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
        if (e instanceof APIStatusError && !e.retryable) {
          throw e;
        }
        if (e instanceof APIConnectionError) {
          this.#logger.warn({ error: String(e) }, 'failed to call lemonslice api');
        } else {
          this.#logger.error({ error: e }, 'failed to call lemonslice api');
        }

        if (i <= this.connOptions.maxRetry - 1) {
          await new Promise((resolve) =>
            setTimeout(resolve, intervalForRetry(this.connOptions, i)),
          );
        }
      }
    }

    throw new APIConnectionError({
      message: 'Failed to start LemonSlice Avatar Session after all retries',
    });
  }
}
