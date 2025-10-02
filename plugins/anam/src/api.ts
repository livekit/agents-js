// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { log } from '@livekit/agents';
import { type APIConnectOptions, AnamException, type PersonaConfig } from './types.js';

const DEFAULT_API_URL = 'https://api.anam.ai';

export class AnamAPI {
  constructor(
    private apiKey: string,
    private apiUrl: string = DEFAULT_API_URL,
    private conn: APIConnectOptions = { maxRetry: 3, retryInterval: 2, timeout: 10 },
  ) {}

  private get tokenPath(): string {
    return '/v1/auth/session-token';
  }

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
    let lastErr: unknown;
    const logger = log().child({ module: 'AnamAPI' });

    for (let attempt = 0; attempt < maxRetry; attempt++) {
      try {
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          ...headersIn,
        };

        const redactedHeaders: Record<string, string> = { ...headers };
        if (redactedHeaders.Authorization) {
          redactedHeaders.Authorization = 'Bearer ****';
        }
        const redactedBody = (() => {
          if (body && typeof body === 'object') {
            try {
              const clone = { ...(body as Record<string, unknown>) } as Record<string, unknown>;
              if ('livekitToken' in clone) clone.livekitToken = '****';
              if ('sessionToken' in clone) clone.sessionToken = '****' as unknown as never;
              return clone;
            } catch {
              return { note: 'unserializable body' };
            }
          }
          return body;
        })();

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
          // simple timeout: rely on AbortController in real impl
        });
        if (!res.ok) {
          const text = await res.text();
          logger.error(
            {
              url,
              method: 'POST',
              headers: redactedHeaders,
              body: redactedBody,
              status: res.status,
              response: text,
            },
            'Anam API request failed',
          );
          throw new AnamException(`Anam ${path} failed: ${res.status} ${text}`);
        }
        const json = (await res.json()) as T;
        logger.debug({ url }, 'Anam API request succeeded');
        return json;
      } catch (e) {
        lastErr = e;
        if (attempt === maxRetry - 1) break;
        logger.warn(
          {
            url,
            method: 'POST',
            body:
              body && typeof body === 'object'
                ? { ...(body as Record<string, unknown>), livekitToken: '****' }
                : body,
            error: (e as Error)?.message,
            nextRetrySec: retryInterval,
          },
          'Anam API error, retrying',
        );
        await new Promise((r) => setTimeout(r, retryInterval * 1000));
      }
    }
    throw lastErr instanceof Error ? lastErr : new AnamException('Anam API error');
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    return this.postWithHeaders<T>(path, body, { Authorization: `Bearer ${this.apiKey}` });
  }

  createSessionToken(params: {
    personaConfig: PersonaConfig;
    livekitUrl?: string;
    livekitToken?: string;
  }) {
    const pc = params.personaConfig;
    const personaPayload = {
      type: 'ephemeral',
      name: pc.name,
      avatarId: pc.avatarId,
      llmId: 'CUSTOMER_CLIENT_V1',
    };

    const payload: Record<string, unknown> = {
      personaConfig: personaPayload,
    };
    payload.environment = {
      livekitUrl: params.livekitUrl,
      livekitToken: params.livekitToken,
    };

    return this.post<{ sessionToken: string }>(this.tokenPath, payload);
  }

  startEngineSession(params: { sessionToken: string }) {
    return this.postWithHeaders<{ sessionId: string }>(
      this.startPath,
      {},
      { Authorization: `Bearer ${params.sessionToken}` },
    );
  }
}
