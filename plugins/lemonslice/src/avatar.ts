// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type APIConnectOptions,
  APIConnectionError,
  APIStatusError,
  DEFAULT_API_CONNECT_OPTIONS,
  type RoomInputOptions,
  type RoomOutputOptions,
  getJobContext,
  intervalForRetry,
  toSnakeCaseDeep,
  voice,
} from '@livekit/agents';
import type { Room } from '@livekit/rtc-node';
import { TrackKind } from '@livekit/rtc-node';
import type { VideoGrant } from 'livekit-server-sdk';
import { AccessToken } from 'livekit-server-sdk';
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { log } from './log.js';
import { MeetingAudioInput, streamMeetingRelay } from './meeting/audio.js';
import { MeetingChatRelay } from './meeting/chat.js';
import type { JoinMeetingResult } from './meeting/room.js';

const ATTRIBUTE_PUBLISH_ON_BEHALF = 'lk.publish_on_behalf';
const DEFAULT_API_URL = 'https://lemonslice.com/api/liveai/sessions';
const SAMPLE_RATE = 16000;
const AVATAR_AGENT_IDENTITY = 'lemonslice-avatar-agent';
const AVATAR_AGENT_NAME = 'lemonslice-avatar-agent';
const MEETING_BROADCAST_IDENTITY = 'lemonslice-meeting-broadcast';

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
   * Exactly one of agentId, agentImageUrl, or agentImage must be provided.
   */
  agentId?: string | null;
  /**
   * The URL of the image to use as the agent's avatar.
   * Exactly one of agentId, agentImageUrl, or agentImage must be provided.
   */
  agentImageUrl?: string | null;
  /**
   * A local image file path or Buffer to upload as the agent's avatar.
   * Exactly one of agentId, agentImageUrl, or agentImage must be provided.
   */
  agentImage?: string | Buffer | null;
  /**
   * MIME type for the agentImage when provided as a Buffer (e.g. 'image/png').
   * Defaults to 'image/png'.
   */
  agentImageMimeType?: string;
  /**
   * A prompt that subtly influences the avatar's movements and expressions while responding.
   */
  agentPrompt?: string | null;
  /**
   * A prompt that subtly influences the avatar's movements and expressions while idle.
   */
  agentIdlePrompt?: string | null;
  /**
   * The idle timeout, in seconds. Defaults to 60 seconds.
   */
  idleTimeout?: number | null;
  /**
   * Additional payload fields to merge into the LemonSlice session creation request.
   */
  extraPayload?: Record<string, unknown> | null;
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

export interface RoomOptions {
  inputOptions?: Partial<RoomInputOptions>;
  outputOptions?: Partial<RoomOutputOptions>;
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
export class AvatarSession extends voice.AvatarSession {
  private agentId: string | null;
  private agentImageUrl: string | null;
  private agentImageBytes: Buffer | null;
  private agentImageMimeType: string;
  private agentPrompt: string | null;
  private agentIdlePrompt: string | null;
  private idleTimeout: number | null;
  private extraPayload: Record<string, unknown> | null;
  private apiUrl: string;
  private apiKey: string;
  private avatarParticipantIdentity: string;
  private avatarParticipantName: string;
  private connOptions: APIConnectOptions;

  private agentSession: voice.AgentSession | null = null;
  private livekitUrl: string | null = null;
  private livekitApiKey: string | null = null;
  private livekitApiSecret: string | null = null;
  private livekitRoom: string | null = null;
  private meetingBotId: string | null = null;
  private meetingAudio: MeetingAudioInput | null = null;
  private meetingChat: MeetingChatRelay | null = null;
  private meetingRelayAbort: AbortController | null = null;
  private meetingRelayTask: Promise<void> | null = null;

  #sessionId: string | null = null;
  #logger = log();

  /**
   * Creates a new AvatarSession.
   *
   * @param options - Configuration options for the avatar session
   * @throws LemonSliceException if invalid agentId or agentImageUrl is provided, or if LemonSlice API key is not set
   */
  constructor(options: AvatarSessionOptions = {}) {
    super();
    this.agentId = options.agentId ?? null;
    this.agentImageUrl = options.agentImageUrl ?? null;

    const sourceCount = [this.agentId, this.agentImageUrl, options.agentImage].filter(
      Boolean,
    ).length;
    if (sourceCount === 0) {
      throw new LemonSliceException('Missing one of agentId, agentImageUrl, or agentImage');
    }
    if (sourceCount > 1) {
      throw new LemonSliceException(
        'Only one of agentId, agentImageUrl, or agentImage can be provided',
      );
    }

    this.agentImageMimeType = 'image/png';
    if (options.agentImage) {
      if (typeof options.agentImage === 'string') {
        this.agentImageMimeType = mimeTypeFromExtension(extname(options.agentImage));
        this.agentImageBytes = readFileSync(options.agentImage);
      } else {
        this.agentImageMimeType = options.agentImageMimeType ?? 'image/png';
        validateMimeType(this.agentImageMimeType);
        this.agentImageBytes = options.agentImage;
      }
    } else {
      this.agentImageBytes = null;
    }

    this.agentPrompt = options.agentPrompt ?? null;
    this.agentIdlePrompt = options.agentIdlePrompt ?? null;
    this.idleTimeout = options.idleTimeout ?? null;
    this.extraPayload = options.extraPayload ?? null;

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

  override get avatarIdentity(): string {
    return this.avatarParticipantIdentity;
  }

  override get provider(): string {
    return 'lemonslice';
  }

  /** The LemonSlice session ID, set after {@link start} completes. */
  get sessionId(): string | null {
    return this.#sessionId;
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
   * @returns The session ID of the LemonSlice session
   */
  async start(
    agentSession: voice.AgentSession,
    room: Room,
    options: StartOptions = {},
  ): Promise<string> {
    await super.start(agentSession, room);

    const livekitUrl = options.livekitUrl || process.env.LIVEKIT_URL;
    const livekitApiKey = options.livekitApiKey || process.env.LIVEKIT_API_KEY;
    const livekitApiSecret = options.livekitApiSecret || process.env.LIVEKIT_API_SECRET;

    if (!livekitUrl || !livekitApiKey || !livekitApiSecret) {
      throw new LemonSliceException(
        'livekitUrl, livekitApiKey, and livekitApiSecret must be set ' +
          'by arguments or environment variables',
      );
    }

    this.agentSession = agentSession;
    this.livekitUrl = livekitUrl;
    this.livekitApiKey = livekitApiKey;
    this.livekitApiSecret = livekitApiSecret;
    this.livekitRoom = room.name ?? null;

    let localParticipantIdentity: string;
    let livekitSessionId: string | undefined;
    const jobCtx = getJobContext(false);
    if (jobCtx) {
      localParticipantIdentity = jobCtx.agent?.identity || '';
      if (!localParticipantIdentity && room.localParticipant) {
        localParticipantIdentity = room.localParticipant.identity;
      }
      livekitSessionId = jobCtx.job.room?.sid;
    } else {
      if (!room.isConnected || !room.localParticipant) {
        throw new LemonSliceException('failed to get local participant identity');
      }
      localParticipantIdentity = room.localParticipant.identity;
    }

    if (!localParticipantIdentity) {
      throw new LemonSliceException('failed to get local participant identity');
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

    // allow the avatar agent to publish audio and video on behalf of your local agent
    at.attributes = {
      [ATTRIBUTE_PUBLISH_ON_BEHALF]: localParticipantIdentity,
    };

    const livekitToken = await at.toJwt();

    this.#logger.debug('starting avatar session');
    const sessionId = await this.startAgent(livekitUrl, livekitToken, livekitSessionId);
    this.#sessionId = sessionId;

    agentSession.output.audio = new voice.DataStreamAudioOutput({
      room,
      destinationIdentity: this.avatarIdentity,
      sampleRate: SAMPLE_RATE,
      waitRemoteTrack: TrackKind.KIND_VIDEO,
      waitPlaybackStart: true,
    });

    return sessionId;
  }

  /**
   * Send this avatar into an external video meeting.
   *
   * Supports Zoom, Google Meet, Microsoft Teams, and Webex. Call after start()
   * and before AgentSession.start().
   */
  async joinMeeting(
    meetingUrl: string,
    {
      botName,
      listenToMeetingChat = true,
    }: {
      botName?: string | null;
      listenToMeetingChat?: boolean;
    } = {},
  ): Promise<JoinMeetingResult> {
    if (!this.#sessionId || this.agentSession === null || !this.livekitUrl) {
      throw new LemonSliceException('call start() before joinMeeting()');
    }
    if (this.meetingBotId !== null) {
      throw new LemonSliceException('already joined a meeting; call leaveMeeting() first');
    }

    const broadcastToken = await this.mintBroadcastToken();
    const result = await this.callJoinMeeting(this.#sessionId, {
      meetingUrl,
      livekitUrl: this.livekitUrl,
      broadcastToken,
      botName,
    });
    this.meetingBotId = result.meetingBotId;

    const meetingAudio = new MeetingAudioInput();
    this.meetingAudio = meetingAudio;
    this.agentSession.input.audio = meetingAudio;

    const relayAbort = new AbortController();
    this.meetingRelayAbort = relayAbort;

    let chatSink: ((payload: string) => void) | undefined;
    if (listenToMeetingChat) {
      const chatRelay = new MeetingChatRelay(this.agentSession, { botName });
      chatRelay.start();
      this.meetingChat = chatRelay;
      chatSink = (payload) => chatRelay.submitJson(payload);
    }

    this.meetingRelayTask = streamMeetingRelay(
      result.websocketUrl,
      (payload) => {
        meetingAudio.submit(payload);
      },
      {
        stop: relayAbort.signal,
        chatSink,
      },
    );

    return result;
  }

  /** Leave the external meeting and stop the audio and chat relay. */
  async leaveMeeting(): Promise<void> {
    const meetingBotId = this.meetingBotId;
    const sessionId = this.#sessionId;
    if (!meetingBotId || !sessionId) {
      return;
    }

    try {
      await this.callLeaveMeeting(sessionId, meetingBotId);
    } catch (error) {
      this.#logger.warn({ error }, 'failed to leave meeting via LemonSlice API');
    } finally {
      this.meetingBotId = null;

      if (this.meetingRelayAbort !== null) {
        this.meetingRelayAbort.abort();
      }
      const relayTask = this.meetingRelayTask;
      if (relayTask !== null) {
        await relayTask.catch(() => undefined);
        this.meetingRelayTask = null;
      }

      if (this.meetingChat !== null) {
        await this.meetingChat.aclose();
        this.meetingChat = null;
      }

      const meetingAudio = this.meetingAudio;
      this.meetingAudio = null;
      if (meetingAudio !== null) {
        if (this.agentSession?.input.audio === meetingAudio) {
          this.agentSession.input.audio = null;
        }
        await meetingAudio.close().catch(() => undefined);
      }

      this.meetingRelayAbort = null;
    }
  }

  /**
   * Return room I/O options for AgentSession.start().
   *
   * When joinMeeting() has been called, disables LiveKit room audio input and output.
   * Meeting audio is fed directly into STT instead.
   */
  roomOptions(options: RoomOptions = {}): RoomOptions {
    if (this.meetingBotId !== null) {
      return {
        inputOptions: { ...options.inputOptions, audioEnabled: false, closeOnDisconnect: false },
        outputOptions: { ...options.outputOptions, audioEnabled: false },
      };
    }
    return options;
  }

  override async aclose(): Promise<void> {
    try {
      await this.leaveMeeting();
    } finally {
      await super.aclose();
    }
  }

  private async startAgent(
    livekitUrl: string,
    livekitToken: string,
    livekitSessionId?: string,
  ): Promise<string> {
    for (let i = 0; i <= this.connOptions.maxRetry; i++) {
      try {
        const properties: Record<string, string> = {
          livekit_url: livekitUrl,
          livekit_token: livekitToken,
        };
        if (livekitSessionId) {
          properties.livekit_session_id = livekitSessionId;
        }

        const payload: Record<string, unknown> = {
          transport_type: 'livekit',
          properties,
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

        if (this.agentIdlePrompt) {
          payload.agent_idle_prompt = this.agentIdlePrompt;
        }

        if (this.idleTimeout !== null) {
          payload.idle_timeout = this.idleTimeout;
        }

        if (this.extraPayload) {
          Object.assign(payload, toSnakeCaseDeep(this.extraPayload) as Record<string, unknown>);
        }

        const headers: Record<string, string> = {
          'X-API-Key': this.apiKey,
        };
        let body: BodyInit;

        if (this.agentImageBytes) {
          const formData = new FormData();
          formData.append('payload', JSON.stringify(payload));
          formData.append(
            'image',
            new Blob([new Uint8Array(this.agentImageBytes)], { type: this.agentImageMimeType }),
            `image${extensionFromMimeType(this.agentImageMimeType)}`,
          );
          body = formData;
        } else {
          headers['Content-Type'] = 'application/json';
          body = JSON.stringify(payload);
        }

        const response = await fetch(this.apiUrl, {
          method: 'POST',
          headers,
          body,
          signal: AbortSignal.timeout(this.connOptions.timeoutMs),
        });

        if (!response.ok) {
          const text = await response.text();
          throw new APIStatusError({
            message: 'Server returned an error',
            options: { statusCode: response.status, body: { error: text } },
          });
        }
        const data = (await response.json()) as { session_id: string };
        return data.session_id;
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

  private async callJoinMeeting(
    sessionId: string,
    {
      meetingUrl,
      livekitUrl,
      broadcastToken,
      botName,
    }: {
      meetingUrl: string;
      livekitUrl: string;
      broadcastToken: string;
      botName?: string | null;
    },
  ): Promise<JoinMeetingResult> {
    const payload: Record<string, unknown> = {
      session_id: sessionId,
      meeting_url: meetingUrl,
      livekit_url: livekitUrl,
      broadcast_token: broadcastToken,
    };
    if (botName?.trim()) {
      payload.bot_name = botName.trim();
    }

    const url = `${this.apiUrl.replace(/\/$/, '')}/${sessionId}/join-meeting`;
    const data = await this.postMeeting(url, payload);
    const websocketUrl = data.websocket_url;
    const meetingBotId = data.meeting_bot_id;
    if (typeof websocketUrl !== 'string' || !websocketUrl) {
      throw new LemonSliceException('join-meeting response missing websocket_url');
    }
    if (typeof meetingBotId !== 'string' || !meetingBotId) {
      throw new LemonSliceException('join-meeting response missing meeting_bot_id');
    }
    return { websocketUrl, meetingBotId };
  }

  private async callLeaveMeeting(sessionId: string, meetingBotId: string): Promise<void> {
    const url = `${this.apiUrl.replace(/\/$/, '')}/${sessionId}/leave-meeting`;
    await this.postMeeting(url, { meeting_bot_id: meetingBotId });
  }

  private async postMeeting(
    url: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    for (let i = 0; i <= this.connOptions.maxRetry; i++) {
      try {
        const response = await fetch(url, {
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

        return (await response.json()) as Record<string, unknown>;
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
      message: 'Failed to call LemonSlice API after all retries',
    });
  }

  private async mintBroadcastToken(): Promise<string> {
    if (!this.livekitApiKey || !this.livekitApiSecret || !this.livekitRoom) {
      throw new LemonSliceException('call start() before joinMeeting()');
    }

    const at = new AccessToken(this.livekitApiKey, this.livekitApiSecret, {
      identity: MEETING_BROADCAST_IDENTITY,
      name: MEETING_BROADCAST_IDENTITY,
      ttl: '4h',
    });

    at.addGrant({
      roomJoin: true,
      room: this.livekitRoom,
      canSubscribe: true,
      canPublish: false,
      canPublishData: false,
    } as VideoGrant);

    return at.toJwt();
  }
}

const MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

const SUPPORTED_MIME_TYPES = new Set(Object.values(MIME_TYPES));

function mimeTypeFromExtension(ext: string): string {
  const mime = MIME_TYPES[ext.toLowerCase()];
  if (!mime) {
    throw new LemonSliceException(
      `Unsupported image extension '${ext}'. Supported: ${Object.keys(MIME_TYPES).join(', ')}`,
    );
  }
  return mime;
}

function validateMimeType(mime: string): void {
  if (!SUPPORTED_MIME_TYPES.has(mime)) {
    throw new LemonSliceException(
      `Unsupported MIME type '${mime}'. Supported: ${[...SUPPORTED_MIME_TYPES].join(', ')}`,
    );
  }
}

function extensionFromMimeType(mime: string): string {
  for (const [ext, type] of Object.entries(MIME_TYPES)) {
    if (type === mime) return ext;
  }
  return '.png';
}
