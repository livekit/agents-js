// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type APIConnectOptions,
  APIConnectionError,
  APIStatusError,
  DEFAULT_API_CONNECT_OPTIONS,
  intervalForRetry,
  shortuuid,
} from '@livekit/agents';
import { log } from './log.js';

/** @public */
export const DEFAULT_API_URL = 'https://tavusapi.com/v2';

// Stock Tavus PAL. Use createPal() to create a PAL with the appearance you'd like.
const DEFAULT_PAL_ID = 'pb87e71797da';

/**
 * Exception thrown when the Tavus plugin or Tavus service errors.
 *
 * @public
 */
export class TavusException extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TavusException';
  }
}

/** @public */
export interface CreateConversationOptions {
  /** Tavus face id. Falls back to `TAVUS_FACE_ID`. */
  faceId?: string;
  /** Tavus pal id. Falls back to `TAVUS_PAL_ID`; created automatically when omitted. */
  palId?: string;
  /** @deprecated Use {@link CreateConversationOptions.faceId | faceId} instead. */
  replicaId?: string;
  /** @deprecated Use {@link CreateConversationOptions.palId | palId} instead. */
  personaId?: string;
  /** Conversation properties passed through to Tavus. */
  properties?: Record<string, unknown>;
  /** Additional fields to merge into the Tavus conversation creation payload. */
  extraPayload?: Record<string, unknown>;
}

function resolveRenamedOption(
  newValue: string | undefined,
  deprecatedValue: string | undefined,
  deprecatedName: string,
  newName: string,
): string | undefined {
  // Prefer the new option; fall back to the deprecated alias and warn only when it's used.
  if (!newValue && deprecatedValue) {
    log().warn(`\`${deprecatedName}\` is deprecated, use \`${newName}\` instead`);
  }
  return newValue || deprecatedValue;
}

function deprecatedEnv(deprecatedName: string, newName: string): string | undefined {
  // Read a deprecated env var, warning if it's set so callers migrate to `newName`.
  const value = process.env[deprecatedName];
  if (value) {
    log().warn(`\`${deprecatedName}\` is deprecated, use \`${newName}\` instead`);
  }
  return value;
}

/** @public */
export interface CreatePalOptions {
  /** Tavus pal name. Generated automatically when omitted. */
  name?: string;
  /** Default face id for the pal (required by `/v2/pals`). */
  defaultFaceId: string;
  /** Additional fields to merge into the Tavus pal creation payload. */
  extraPayload?: Record<string, unknown>;
}

/** @public */
export interface CreatePersonaOptions {
  /** Tavus persona name. Generated automatically when omitted. */
  name?: string;
  /** Additional fields to merge into the Tavus persona creation payload. */
  extraPayload?: Record<string, unknown>;
}

/** @public */
export interface TavusAPIOptions {
  /** Tavus API key. Falls back to `TAVUS_API_KEY`. */
  apiKey?: string;
  /** Override the Tavus API base URL. */
  apiUrl?: string;
  /** API retry/timeout options. */
  connOptions?: APIConnectOptions;
}

/**
 * Thin client for the Tavus HTTP API.
 *
 * @public
 */
export class TavusAPI {
  private apiKey: string;
  private apiUrl: string;
  private connOptions: APIConnectOptions;

  #logger = log();

  constructor(options: TavusAPIOptions = {}) {
    const apiKey = options.apiKey ?? process.env.TAVUS_API_KEY ?? '';
    if (!apiKey) {
      throw new TavusException('TAVUS_API_KEY must be set');
    }

    this.apiKey = apiKey;
    this.apiUrl = options.apiUrl || DEFAULT_API_URL;
    this.connOptions = options.connOptions || DEFAULT_API_CONNECT_OPTIONS;
  }

  async createConversation(options: CreateConversationOptions = {}): Promise<string> {
    const faceId =
      resolveRenamedOption(options.faceId, options.replicaId, 'replicaId', 'faceId') ||
      process.env.TAVUS_FACE_ID ||
      deprecatedEnv('TAVUS_REPLICA_ID', 'TAVUS_FACE_ID');

    let palId =
      resolveRenamedOption(options.palId, options.personaId, 'personaId', 'palId') ||
      process.env.TAVUS_PAL_ID ||
      deprecatedEnv('TAVUS_PERSONA_ID', 'TAVUS_PAL_ID');

    if (!palId) {
      // no pal supplied — use the default stock pal (carries its own face)
      palId = DEFAULT_PAL_ID;
    }

    const payload: Record<string, unknown> = {
      pal_id: palId,
      properties: options.properties ?? {},
    };
    // send face_id only when given; otherwise the pal's default_face_id is used
    if (faceId) {
      payload.face_id = faceId;
    }

    if (options.extraPayload) {
      Object.assign(payload, options.extraPayload);
    }

    if (!('conversation_name' in payload)) {
      payload.conversation_name = shortuuid('lk_conversation_');
    }

    const responseData = (await this.post('conversations', payload)) as { conversation_id: string };
    return responseData.conversation_id;
  }

  async createPal(options: CreatePalOptions): Promise<string> {
    const payload: Record<string, unknown> = {
      pal_name: options.name || shortuuid('lk_pal_'),
      default_face_id: options.defaultFaceId,
      pipeline_mode: 'echo',
      layers: {
        transport: { transport_type: 'livekit' },
      },
    };

    if (options.extraPayload) {
      Object.assign(payload, options.extraPayload);
    }

    const responseData = (await this.post('pals', payload)) as { pal_id: string };
    return responseData.pal_id;
  }

  /** @deprecated Use {@link TavusAPI.createPal | createPal} instead. */
  async createPersona(options: CreatePersonaOptions = {}): Promise<string> {
    log().warn('`createPersona` is deprecated, use `createPal` instead');
    const payload: Record<string, unknown> = {
      persona_name: options.name || shortuuid('lk_persona_'),
      pipeline_mode: 'echo',
      layers: {
        transport: { transport_type: 'livekit' },
      },
    };

    if (options.extraPayload) {
      Object.assign(payload, options.extraPayload);
    }

    const responseData = (await this.post('personas', payload)) as { persona_id: string };
    return responseData.persona_id;
  }

  private async post(endpoint: string, payload: Record<string, unknown>): Promise<unknown> {
    const url = `${this.apiUrl}/${endpoint}`;

    for (let i = 0; i <= this.connOptions.maxRetry; i++) {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': this.apiKey,
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

        return await response.json();
      } catch (e) {
        if (e instanceof APIStatusError && !e.retryable) {
          throw e;
        }
        if (e instanceof APIConnectionError) {
          this.#logger.warn({ error: String(e) }, 'failed to call tavus api');
        } else {
          this.#logger.error({ error: e }, 'failed to call tavus api');
        }

        if (i < this.connOptions.maxRetry) {
          await new Promise((resolve) =>
            setTimeout(resolve, intervalForRetry(this.connOptions, i)),
          );
        }
      }
    }

    throw new APIConnectionError({
      message: 'Failed to call Tavus API after all retries',
    });
  }
}
