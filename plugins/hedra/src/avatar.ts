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

const DEFAULT_API_URL = 'https://api.hedra.com/public/livekit/v1/session';
const SAMPLE_RATE = 16000;
const AVATAR_AGENT_IDENTITY = 'hedra-avatar-agent';
const AVATAR_AGENT_NAME = 'hedra-avatar-agent';

/**
 * Exception thrown when there are errors with the Hedra API.
 */
export class HedraException extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HedraException';
  }
}

/**
 * Represents an image that can be used as an avatar.
 * This can be a Buffer containing raw image data with a specified MIME type.
 */
export interface AvatarImage {
  /**
   * The raw image data as a Buffer.
   */
  data: Buffer;
  /**
   * The MIME type of the image (e.g., 'image/jpeg', 'image/png').
   */
  mimeType: string;
  /**
   * Optional filename for the image.
   */
  filename?: string;
}

/**
 * Options for configuring an AvatarSession.
 */
export interface AvatarSessionOptions {
  /**
   * The avatar ID to use. Either avatarId or avatarImage must be provided.
   */
  avatarId?: string | null;
  /**
   * A custom avatar image to use. Either avatarId or avatarImage must be provided.
   */
  avatarImage?: AvatarImage | null;
  /**
   * The Hedra API URL. Defaults to https://api.hedra.com/public/livekit/v1/session
   * or HEDRA_API_URL environment variable.
   */
  apiUrl?: string;
  /**
   * The Hedra API key. Can also be set via HEDRA_API_KEY environment variable.
   */
  apiKey?: string;
  /**
   * The identity of the avatar participant in the room. Defaults to 'hedra-avatar-agent'.
   */
  avatarParticipantIdentity?: string;
  /**
   * The name of the avatar participant in the room. Defaults to 'hedra-avatar-agent'.
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
 * A Hedra avatar session.
 *
 * This class manages the connection between a LiveKit agent and a Hedra avatar,
 * routing agent audio output to the avatar for visual representation.
 *
 * @example
 * ```typescript
 * // Using an avatar ID
 * const avatar = new AvatarSession({
 *   avatarId: 'your-avatar-id',
 *   apiKey: 'your-hedra-api-key',
 * });
 * await avatar.start(agentSession, room);
 *
 * // Using a custom avatar image
 * const imageBuffer = fs.readFileSync('avatar.jpg');
 * const avatar = new AvatarSession({
 *   avatarImage: {
 *     data: imageBuffer,
 *     mimeType: 'image/jpeg',
 *     filename: 'avatar.jpg',
 *   },
 *   apiKey: 'your-hedra-api-key',
 * });
 * await avatar.start(agentSession, room);
 * ```
 */
export class AvatarSession {
  private avatarId: string | null;
  private avatarImage: AvatarImage | null;
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
   * @throws HedraException if neither avatarId nor avatarImage is provided, or if HEDRA_API_KEY is not set
   */
  constructor(options: AvatarSessionOptions = {}) {
    this.avatarId = options.avatarId ?? null;
    this.avatarImage = options.avatarImage ?? null;

    if (!this.avatarId && !this.avatarImage) {
      throw new HedraException('avatarId or avatarImage must be provided');
    }

    this.apiUrl = options.apiUrl || process.env.HEDRA_API_URL || DEFAULT_API_URL;
    this.apiKey = options.apiKey || process.env.HEDRA_API_KEY || '';

    if (!this.apiKey) {
      throw new HedraException(
        'The api_key must be set either by passing apiKey to the client or ' +
          'by setting the HEDRA_API_KEY environment variable',
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
   * 2. Calls the Hedra API to start the avatar session
   * 3. Configures the agent's audio output to stream to the avatar
   *
   * @param agentSession - The agent session to connect to the avatar
   * @param room - The LiveKit room where the avatar will join
   * @param options - Optional LiveKit credentials (falls back to environment variables)
   * @throws HedraException if LiveKit credentials are not available or if the avatar session fails to start
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
      throw new HedraException(
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
    } catch {
      if (!room.isConnected || !room.localParticipant) {
        throw new HedraException('failed to get local participant identity');
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
      sampleRate: SAMPLE_RATE,
      waitRemoteTrack: TrackKind.KIND_VIDEO,
    });
  }

  private async startAgent(livekitUrl: string, livekitToken: string): Promise<void> {
    for (let i = 0; i < this.connOptions.maxRetry; i++) {
      try {
        // Always use FormData (matching Python implementation)
        const formData = new FormData();
        formData.append('livekit_url', livekitUrl);
        formData.append('livekit_token', livekitToken);

        if (this.avatarId) {
          formData.append('avatar_id', this.avatarId);
        }

        if (this.avatarImage) {
          const blob = new Blob([new Uint8Array(this.avatarImage.data)], {
            type: this.avatarImage.mimeType,
          });
          formData.append('avatar_image', blob, this.avatarImage.filename || 'avatar.jpg');
        }

        const response = await fetch(this.apiUrl, {
          method: 'POST',
          headers: {
            'x-api-key': this.apiKey,
          },
          body: formData,
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
          this.#logger.warn({ error: String(e) }, 'failed to call hedra avatar api');
        } else {
          this.#logger.error({ error: e }, 'failed to call hedra avatar api');
        }

        if (i < this.connOptions.maxRetry - 1) {
          await new Promise((resolve) =>
            setTimeout(resolve, intervalForRetry(this.connOptions, i)),
          );
        }
      }
    }

    throw new APIConnectionError({
      message: 'Failed to start Hedra Avatar Session after all retries',
    });
  }
}
