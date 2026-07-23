// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { Room } from '@livekit/rtc-node';
import { TrackKind } from '@livekit/rtc-node';
import type { VideoGrant } from 'livekit-server-sdk';
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
import { randomUUID } from 'node:crypto';
import { APIConnectionError, APIError, APIStatusError, APITimeoutError } from '../_exceptions.js';
import { ATTRIBUTE_PUBLISH_ON_BEHALF } from '../constants.js';
import { getJobContext } from '../job.js';
import { log } from '../log.js';
import {
  type APIConnectOptions,
  DEFAULT_API_CONNECT_OPTIONS,
  intervalForRetry,
} from '../types.js';
import type { AgentSession } from '../voice/agent_session.js';
import {
  AvatarSession as BaseAvatarSession,
  DataStreamAudioOutput,
} from '../voice/avatar/index.js';
import {
  INFERENCE_PROVIDER_HEADER,
  buildMetadataHeaders,
  createAccessToken,
  getDefaultInferenceUrl,
} from './utils.js';

const DEFAULT_SAMPLE_RATE = 16000;
const ATTRIBUTE_AVATAR_PROVIDER = 'lk.avatar_provider';

export interface LemonSliceOptions {
  /** Appearance source; mutually exclusive with a model-string agent id. */
  image_url?: string;
  /** Speaking prompt, mapped to the provider's agent_prompt. */
  prompt?: string;
  /** Idle prompt, mapped to the provider's agent_idle_prompt. */
  idle_prompt?: string;
  /** Provider idle timeout in seconds; the gateway clamps it. */
  idle_timeout?: number;
  [key: string]: unknown;
}

const OPTION_TO_PAYLOAD_FIELD: Record<string, string> = {
  image_url: 'image_url',
  prompt: 'prompt',
  idle_prompt: 'idle_prompt',
  idle_timeout: 'idle_timeout_s',
};

export type AvatarModel = 'lemonslice' | `lemonslice/${string}` | (string & NonNullable<unknown>);

export interface AvatarSessionOptions {
  /** `"<provider>"` or `"<provider>/<avatar_id>"`, e.g. `"lemonslice/agent_abc"`. */
  model: AvatarModel;
  /** Room identity for the avatar worker. Defaults to `"<provider>-inference-avatar"`. */
  avatarParticipantIdentity?: string;
  /** Display name for the avatar worker. */
  avatarParticipantName?: string;
  /** Provider-specific options. For LemonSlice, use {@link LemonSliceOptions}. */
  extraKwargs?: LemonSliceOptions | Record<string, unknown>;
  /** Inference gateway base URL. Defaults to the environment's gateway. */
  baseURL?: string;
  /** Gateway API key. Falls back to LIVEKIT_INFERENCE_API_KEY then LIVEKIT_API_KEY. */
  apiKey?: string;
  /** Gateway API secret. Falls back to LIVEKIT_INFERENCE_API_SECRET then LIVEKIT_API_SECRET. */
  apiSecret?: string;
  /** Optional fetch implementation, primarily for tests. */
  fetch?: typeof fetch;
  /** Retry and connect-timeout options for gateway calls. */
  connOptions?: APIConnectOptions;
}

export interface AvatarSessionStartOptions {
  /** LiveKit server URL. Falls back to LIVEKIT_URL. */
  livekitUrl?: string;
  /** LiveKit API key for minting the avatar worker room token. Falls back to LIVEKIT_API_KEY. */
  livekitApiKey?: string;
  /** LiveKit API secret for minting the avatar worker room token. Falls back to LIVEKIT_API_SECRET. */
  livekitApiSecret?: string;
}

type CreateSessionResponse = {
  session_id?: string;
  provider_session_id?: string;
  terminate_token?: string;
  sample_rate?: number;
};

export function parseAvatarModel(model: string): [provider: string, avatarId: string | undefined] {
  const [rawProvider, ...rest] = model.split('/');
  const provider = rawProvider?.trim() ?? '';
  if (!provider) {
    throw new Error(
      `invalid avatar model string: ${JSON.stringify(model)} (expected 'provider' or 'provider/<id>')`,
    );
  }
  const avatarId = rest.join('/').trim();
  return [provider, avatarId || undefined];
}

/**
 * An avatar session provisioned through LiveKit Inference.
 *
 * Unlike BYOK avatar plugins, this calls the LiveKit Inference gateway with LiveKit
 * credentials; the gateway creates the provider session with LiveKit's wholesale key.
 * Media and RPC still flow in-room over DataStream, exactly as the BYOK plugins do.
 */
export class AvatarSession extends BaseAvatarSession {
  private readonly logger = log();
  private readonly providerName: string;
  private readonly avatarId?: string;
  private readonly extraKwargs: Record<string, unknown>;
  private readonly connOptions: APIConnectOptions;
  private readonly fetchFn: typeof fetch;
  private readonly baseURL: string;
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly avatarParticipantIdentity: string;
  private readonly avatarParticipantName: string;

  private _started = false;
  private _sessionId: string | null = null;
  private _providerSessionId: string | null = null;
  private _terminateToken: string | null = null;

  constructor(options: AvatarSessionOptions) {
    super();

    const [provider, avatarId] = parseAvatarModel(options.model);
    this.providerName = provider;
    this.avatarId = avatarId;
    this.extraKwargs = { ...(options.extraKwargs ?? {}) };
    if (this.avatarId && 'image_url' in this.extraKwargs) {
      throw new Error(
        `pass either a catalog id in the model string ('${this.providerName}/<avatar_id>') or image_url, not both`,
      );
    }

    this.connOptions = options.connOptions ?? DEFAULT_API_CONNECT_OPTIONS;
    this.fetchFn = options.fetch ?? fetch;
    this.baseURL = options.baseURL ?? getDefaultInferenceUrl();
    this.apiKey =
      options.apiKey ?? process.env.LIVEKIT_INFERENCE_API_KEY ?? process.env.LIVEKIT_API_KEY ?? '';
    if (!this.apiKey) {
      throw new Error(
        'apiKey is required, either as argument or set LIVEKIT_API_KEY environment variable',
      );
    }
    this.apiSecret =
      options.apiSecret ??
      process.env.LIVEKIT_INFERENCE_API_SECRET ??
      process.env.LIVEKIT_API_SECRET ??
      '';
    if (!this.apiSecret) {
      throw new Error(
        'apiSecret is required, either as argument or set LIVEKIT_API_SECRET environment variable',
      );
    }

    this.avatarParticipantIdentity =
      options.avatarParticipantIdentity ?? `${this.providerName}-inference-avatar`;
    this.avatarParticipantName = options.avatarParticipantName ?? this.avatarParticipantIdentity;
  }

  override get avatarIdentity(): string {
    return this.avatarParticipantIdentity;
  }

  override get provider(): string {
    return this.providerName;
  }

  /** The gateway-generated avatar session id, available after start(). */
  get sessionId(): string | null {
    return this._sessionId;
  }

  /** The provider's own session id, available after start(). */
  get providerSessionId(): string | null {
    return this._providerSessionId;
  }

  override async start(
    agentSession: AgentSession,
    room: Room,
    options: AvatarSessionStartOptions = {},
  ): Promise<void> {
    // Set synchronously before any await: two overlapping start() calls must not both
    // pass the guard and create two separately-billed provider sessions. The session ids
    // used to arrive only after several awaits (token mint, sid resolution, gateway create).
    if (this._started) {
      throw new Error(
        'AvatarSession.start() may only be called once per instance; create a new AvatarSession to start another avatar',
      );
    }
    this._started = true;

    await super.start(agentSession, room);

    const livekitUrl = options.livekitUrl ?? process.env.LIVEKIT_URL;
    const livekitApiKey = options.livekitApiKey ?? process.env.LIVEKIT_API_KEY;
    const livekitApiSecret = options.livekitApiSecret ?? process.env.LIVEKIT_API_SECRET;
    if (!livekitUrl || !livekitApiKey || !livekitApiSecret) {
      throw new Error(
        'livekitUrl, livekitApiKey, and livekitApiSecret must be set by arguments or the LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET environment variables',
      );
    }
    const jobCtx = getJobContext(false);
    // `@livekit/rtc-node` `Room.name` is an empty string (not undefined) before the room
    // connects, so use `||` to fall back to the job's room name in that case.
    const roomName = room.name || jobCtx?.job.room?.name;
    if (!roomName) {
      throw new Error('failed to get room name');
    }

    let localParticipantIdentity: string | undefined;
    let roomSid: string | undefined;
    if (jobCtx) {
      localParticipantIdentity =
        jobCtx.agent?.identity ??
        room.localParticipant?.identity ??
        jobCtx.info.acceptArguments.identity;
      roomSid = jobCtx.job.room?.sid;
    } else if (room.isConnected) {
      localParticipantIdentity = room.localParticipant?.identity;
      roomSid = await resolveRoomSid(room, roomName, livekitUrl, livekitApiKey, livekitApiSecret);
    } else {
      throw new Error(
        'AvatarSession.start() needs a connected room or an agent job context; connect the room before calling start()',
      );
    }
    if (!localParticipantIdentity) {
      throw new Error('failed to get local participant identity');
    }
    if (!roomSid) {
      throw new Error('failed to get room sid');
    }

    const workerToken = await this.createWorkerToken({
      livekitApiKey,
      livekitApiSecret,
      roomName,
      localParticipantIdentity,
    });

    const createResp = await this._createSession({
      roomName,
      roomSid,
      livekitUrl,
      workerToken,
      agentIdentity: localParticipantIdentity,
    });

    this._sessionId = createResp.session_id ?? null;
    this._providerSessionId = createResp.provider_session_id ?? null;
    this._terminateToken = createResp.terminate_token ?? null;
    const sampleRate = createResp.sample_rate ?? DEFAULT_SAMPLE_RATE;

    if (!this._providerSessionId) {
      this.logger.warn(
        { provider: this.providerName, sessionId: this._sessionId },
        'avatar gateway create response had no provider_session_id; this session cannot be explicitly terminated and will bill until its provider idle timeout',
      );
    } else if (!this._terminateToken) {
      this.logger.warn(
        {
          provider: this.providerName,
          sessionId: this._sessionId,
          providerSessionId: this._providerSessionId,
        },
        'avatar gateway create response had no terminate_token; this session cannot be explicitly terminated and will bill until its provider idle timeout',
      );
    }

    agentSession.output.audio = new DataStreamAudioOutput({
      room,
      destinationIdentity: this.avatarParticipantIdentity,
      sampleRate,
      waitRemoteTrack: TrackKind.KIND_VIDEO,
      waitPlaybackStart: true,
    });

    this.logger.debug(
      {
        provider: this.providerName,
        sessionId: this._sessionId,
        providerSessionId: this._providerSessionId,
      },
      'inference avatar session created',
    );
  }

  override async aclose(): Promise<void> {
    const providerSessionId = this._providerSessionId;
    const terminateToken = this._terminateToken;
    let terminateError: unknown;
    try {
      if (providerSessionId && terminateToken) {
        try {
          await this._terminateSession(providerSessionId, terminateToken);
          this._providerSessionId = null;
          this._terminateToken = null;
        } catch (error) {
          terminateError = error;
        }
      } else if (providerSessionId) {
        this.logger.debug(
          { provider: this.providerName, providerSessionId },
          'no terminate_token for this avatar session; skipping explicit terminate',
        );
      }
    } finally {
      await super.aclose();
    }

    if (terminateError !== undefined) {
      // Rethrow after base cleanup so a failed terminate escalates through the
      // job-shutdown handler (logger.error 'error while shutting down the job')
      // rather than being a silent warn. _terminateSession has already retried; the
      // provider session will keep billing until its idle timeout.
      throw new Error(
        `failed to terminate inference avatar session after retries ` +
          `(provider=${this.providerName}, providerSessionId=${providerSessionId}); ` +
          `it will keep billing until its provider idle timeout`,
        { cause: terminateError },
      );
    }
  }

  /** @internal */
  async _createSession({
    roomName,
    roomSid,
    livekitUrl,
    workerToken,
    agentIdentity,
  }: {
    roomName: string;
    roomSid: string;
    livekitUrl: string;
    workerToken: string;
    agentIdentity: string;
  }): Promise<CreateSessionResponse> {
    const payload: Record<string, unknown> = {
      provider: this.providerName,
      livekit_url: livekitUrl,
      livekit_token: workerToken,
      room_name: roomName,
      room_sid: roomSid,
      avatar_identity: this.avatarParticipantIdentity,
      agent_identity: agentIdentity,
    };
    if (this.avatarId) {
      payload.avatar_id = this.avatarId;
    }

    const extra: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(this.extraKwargs)) {
      const payloadField = OPTION_TO_PAYLOAD_FIELD[key];
      if (payloadField) {
        payload[payloadField] = value;
      } else {
        extra[key] = value;
      }
    }
    if (Object.keys(extra).length > 0) {
      payload.extra_kwargs = extra;
    }

    // Idempotency-Key stays stable across retries so a replayed create resolves to the
    // same gateway session instead of provisioning a second paid one.
    const idempotencyKey = randomUUID().replaceAll('-', '');
    const url = `${this.baseURL.replace(/\/$/, '')}/avatar/sessions`;
    const response = await this.postJsonRetrying(
      url,
      payload,
      { ...(await this.authHeaders()), 'Idempotency-Key': idempotencyKey },
      'avatar gateway create',
    );
    return (await response.json()) as CreateSessionResponse;
  }

  /** @internal */
  async _terminateSession(providerSessionId: string, terminateToken: string): Promise<void> {
    const url = `${this.baseURL.replace(/\/$/, '')}/avatar/sessions/terminate`;
    // Retry with the same policy as create: terminate is safe to replay (the gateway
    // treats an already-torn-down session as success), so a transient failure at
    // shutdown shouldn't silently leak an idle-timeout window of billing.
    await this.postJsonRetrying(
      url,
      {
        provider: this.providerName,
        provider_session_id: providerSessionId,
        terminate_token: terminateToken,
      },
      await this.authHeaders(),
      'avatar gateway terminate',
    );
  }

  private async authHeaders(): Promise<Record<string, string>> {
    return {
      ...buildMetadataHeaders(),
      Authorization: `Bearer ${await createAccessToken(this.apiKey, this.apiSecret)}`,
      [INFERENCE_PROVIDER_HEADER]: this.providerName,
      'Content-Type': 'application/json',
    };
  }

  /**
   * POST with the shared retry/backoff policy (up to `connOptions.maxRetry` retries).
   * Rethrows immediately on a non-retryable error, and prefers a gateway `Retry-After`
   * hint over the default backoff interval.
   */
  private async postJsonRetrying(
    url: string,
    payload: Record<string, unknown>,
    headers: Record<string, string>,
    label: string,
  ): Promise<Response> {
    let lastError: Error | undefined;
    for (let i = 0; i <= this.connOptions.maxRetry; i++) {
      let retryAfterMs: number | undefined;
      try {
        return await this.postJson(url, payload, headers);
      } catch (error) {
        const apiError = toAPIError(error, `${label} timed out after attempt ${i + 1}`);
        lastError = apiError;
        if (apiError instanceof APIError && !apiError.retryable) {
          throw apiError;
        }
        retryAfterMs = (apiError as { retryAfterMs?: number }).retryAfterMs;
        this.logger.warn(
          { provider: this.providerName, error: String(apiError) },
          apiError instanceof APITimeoutError
            ? 'avatar gateway request timed out'
            : 'failed to call avatar gateway',
        );
      }

      if (i < this.connOptions.maxRetry) {
        const backoffMs = retryAfterMs ?? intervalForRetry(this.connOptions, i);
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }

    throw lastError ?? new APIConnectionError({ message: `${label} failed after all retries` });
  }

  private async postJson(
    url: string,
    payload: Record<string, unknown>,
    headers: Record<string, string>,
  ): Promise<Response> {
    const response = await this.fetchFn(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(this.connOptions.timeoutMs),
    });
    if (!response.ok) {
      const text = await response.text();
      const error = new APIStatusError({
        message: `avatar gateway returned an error: ${text}`,
        options: { statusCode: response.status, body: { error: text } },
      });
      // Surface the gateway's backoff hint (e.g. 60s on 429) so the retry loop can
      // honor it instead of hammering with the default ~2s interval.
      const retryAfterMs = parseRetryAfterMs(response.headers.get('Retry-After'));
      if (retryAfterMs !== undefined) {
        (error as APIStatusError & { retryAfterMs?: number }).retryAfterMs = retryAfterMs;
      }
      throw error;
    }
    return response;
  }

  private async createWorkerToken({
    livekitApiKey,
    livekitApiSecret,
    roomName,
    localParticipantIdentity,
  }: {
    livekitApiKey: string;
    livekitApiSecret: string;
    roomName: string;
    localParticipantIdentity: string;
  }): Promise<string> {
    const token = new AccessToken(livekitApiKey, livekitApiSecret, {
      identity: this.avatarParticipantIdentity,
      name: this.avatarParticipantName,
    });
    token.kind = 'agent';
    token.addGrant({ roomJoin: true, room: roomName } as VideoGrant);
    token.attributes = {
      [ATTRIBUTE_PUBLISH_ON_BEHALF]: localParticipantIdentity,
      [ATTRIBUTE_AVATAR_PROVIDER]: this.providerName,
    };
    return await token.toJwt();
  }
}

function toAPIError(error: unknown, timeoutMessage: string): APIError {
  if (error instanceof APIError) return error;
  if (isTimeoutError(error)) return new APITimeoutError({ message: timeoutMessage });
  return new APIConnectionError({ message: String(error) });
}

function isTimeoutError(error: unknown): boolean {
  return (
    error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError')
  );
}

/**
 * Parse an HTTP `Retry-After` header (RFC 7231: delta-seconds or an HTTP-date) into
 * milliseconds. Returns undefined when absent or unparseable.
 */
function parseRetryAfterMs(headerValue: string | null): number | undefined {
  if (!headerValue) return undefined;
  const trimmed = headerValue.trim();
  if (!trimmed) return undefined;

  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) {
    return Math.max(0, Math.round(seconds * 1000));
  }

  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }
  return undefined;
}

async function resolveRoomSid(
  room: Room,
  roomName: string,
  livekitUrl: string,
  livekitApiKey: string,
  livekitApiSecret: string,
): Promise<string | undefined> {
  // `@livekit/rtc-node` `Room` exposes `getSid()` (not a `sid` property); for a connected
  // room it resolves to the server-assigned sid without any extra RPC. Fall back to a
  // RoomService lookup only if it comes back empty (e.g. sid not yet assigned).
  const sid = await room.getSid();
  if (sid) return sid;

  const client = new RoomServiceClient(livekitUrl, livekitApiKey, livekitApiSecret);
  const rooms = await client.listRooms([roomName]);
  return rooms[0]?.sid;
}
