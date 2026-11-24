// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { APIConnectionError, APIStatusError, log } from '@livekit/agents';
import {
  type APIConnectOptions,
  AnamException,
  type PersonaConfig,
  type SessionOptions,
} from './types.js';

const DEFAULT_API_URL = 'https://api.anam.ai';

/** Copy of a request body with the LiveKit join token masked, for logging. */
function redactBody(body: unknown): unknown {
  if (!body || typeof body !== 'object') return body;
  const clone = { ...(body as Record<string, unknown>) };
  const env = clone.environment;
  if (env && typeof env === 'object' && 'livekitToken' in env) {
    clone.environment = { ...(env as Record<string, unknown>), livekitToken: '****' };
  }
  return clone;
}

/** @public */
export class AnamAPI {
  constructor(
    private apiKey: string,
    private apiUrl: string = DEFAULT_API_URL,
    private conn: APIConnectOptions = { maxRetry: 3, retryInterval: 2, timeout: 10 },
  ) {}

  private get startPath(): string {
    return '/v1/engine/session';
  }

  private async postWithHeaders<T>(
    path: string,
    body: unknown,
    headersIn: Record<string, string>,
  ): Promise<T> {
    const url = `${this.apiUrl}${path}`;
    const { maxRetry = 3, retryInterval = 2 } = this.conn;
    const logger = log().child({ module: 'AnamAPI' });
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...headersIn,
    };
    const redactedHeaders = {
      ...headers,
      ...(headers.Authorization ? { Authorization: 'Bearer ****' } : {}),
    };
    const redactedBody = redactBody(body);

    // maxRetry counts retries, so make one first attempt plus up to maxRetry more.
    for (let attempt = 0; attempt <= maxRetry; attempt++) {
      try {
        logger.debug(
          {
            url,
            method: 'POST',
            headers: redactedHeaders,
            body: redactedBody,
            attempt: attempt + 1,
          },
          'calling Anam API',
        );

        const res = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const text = await res.text();
          // APIStatusError marks 4xx (other than 408/429/499) as not retryable.
          throw new APIStatusError({
            message: `Server returned an error for ${url}: ${res.status}`,
            options: { statusCode: res.status, body: text },
          });
        }
        const json = (await res.json()) as T;
        logger.debug({ url }, 'Anam API request succeeded');
        return json;
      } catch (e) {
        const isStatusError = e instanceof APIStatusError;
        if (isStatusError && !e.retryable) {
          logger.error({ url, status: e.statusCode, response: e.body }, 'Anam API request failed');
          throw e;
        }
        logger.warn(
          { url, error: (e as Error)?.message, attempt: attempt + 1 },
          `Anam API request failed on attempt ${attempt + 1}`,
        );
        if (attempt >= maxRetry) {
          if (isStatusError) throw e;
          throw new APIConnectionError({ message: `Failed to connect to Anam API at ${url}` });
        }
        await new Promise((r) => setTimeout(r, retryInterval * 1000));
      }
    }
    throw new APIConnectionError({ message: 'Failed to call Anam API after all retries.' });
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    return this.postWithHeaders<T>(path, body, { Authorization: `Bearer ${this.apiKey}` });
  }

  startSession(params: {
    personaConfig: PersonaConfig;
    livekitUrl?: string;
    livekitToken?: string;
    sessionOptions?: SessionOptions;
  }) {
    const pc = params.personaConfig;
    // Anam's personaConfig is a `oneOf`: reference a previously created
    // (stateful) persona by `personaId` — the "dev flow" — or configure an
    // ephemeral persona inline with name/avatarId/llmId. The two are mutually
    // exclusive, so when a personaId is given we must not also send the
    // ephemeral fields.
    const personaPayload: Record<string, unknown> = pc.personaId
      ? { personaId: pc.personaId }
      : {
          type: 'ephemeral',
          name: pc.name,
          avatarId: pc.avatarId,
          llmId: 'CUSTOMER_CLIENT_V1',
          // Only forward the avatar model version when set; otherwise let Anam
          // fall back to the avatar's default model.
          ...(pc.avatarModel ? { avatarModel: pc.avatarModel } : {}),
        };

    const payload: Record<string, unknown> = {
      personaConfig: personaPayload,
    };
    payload.environment = {
      livekitUrl: params.livekitUrl,
      livekitToken: params.livekitToken,
    };

    if (
      params.sessionOptions &&
      (params.sessionOptions.videoWidth !== undefined ||
        params.sessionOptions.videoHeight !== undefined)
    ) {
      if (
        params.sessionOptions.videoWidth === undefined ||
        params.sessionOptions.videoHeight === undefined
      ) {
        throw new AnamException(
          'videoWidth and videoHeight must be set together (both or neither)',
        );
      }
      payload.sessionOptions = {
        videoWidth: params.sessionOptions.videoWidth,
        videoHeight: params.sessionOptions.videoHeight,
      };
    }

    return this.post<{ sessionId: string }>(this.startPath, payload);
  }
}
