// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { APIError, APIStatusError } from '@livekit/agents';
import { parse } from 'dotenv';
import { readFileSync } from 'node:fs';

export type Fetch = typeof globalThis.fetch;

/** Configuration selected explicitly by the caller, without mutating process.env. */
export class Configuration {
  readonly #values: Record<string, string>;

  constructor(envFile?: string) {
    const path = envFile ?? process.env.MICROSOFT_AI_ENV_FILE;
    if (path === undefined) {
      this.#values = {};
      return;
    }
    try {
      const source = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(path));
      this.#values = parse(source);
    } catch {
      throw new Error('Could not read the selected Microsoft AI environment file');
    }
  }

  get(name: string): string | undefined {
    return process.env[name] ?? this.#values[name];
  }

  required(value: string | undefined, name: string): string {
    const resolved = value ?? this.get(name);
    if (resolved === undefined || resolved.trim() === '') {
      throw new Error(`Set ${name} or pass its constructor argument`);
    }
    return resolved;
  }
}

export function positiveTimeout(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be finite and greater than zero`);
  }
}

export function statusError(service: string, status: number): APIError {
  // Core treats 499 as cancellation, but a remote HTTP 499 is an actual failure.
  if (status === 499) {
    return new APIError(`Microsoft AI ${service} returned HTTP 499`, { retryable: false });
  }
  return new APIStatusError({
    message: `Microsoft AI ${service} request failed`,
    options: { statusCode: status, retryable: status === 408 || status === 429 || status >= 500 },
  });
}

export interface HTTPClientOptions {
  config: Configuration;
  service: 'TTS' | 'STT';
  url: string;
  apiKey?: string;
  headers?: Record<string, string>;
  fetch?: Fetch;
  authHeader?: 'Authorization' | 'api-key';
}

/** A lazy native-fetch wrapper which never owns caller-provided transport state. */
export class HTTPClient {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly #fetch?: Fetch;
  #closed = false;

  constructor(options: HTTPClientOptions) {
    const { config, service, apiKey, headers, authHeader } = options;
    this.url = config.required(options.url, `MICROSOFT_AI_${service}_URL`);
    let parsed: URL;
    try {
      parsed = new URL(this.url);
    } catch {
      throw new Error(
        `MICROSOFT_AI_${service}_URL must be a full ${service === 'STT' ? 'wss' : 'https'} endpoint URL`,
      );
    }
    const secure = service === 'STT' ? 'wss:' : 'https:';
    const local = service === 'STT' ? 'ws:' : 'http:';
    if (
      ![secure, local].includes(parsed.protocol) ||
      !this.url.toLowerCase().startsWith(`${parsed.protocol}//`) ||
      !parsed.hostname ||
      parsed.username !== '' ||
      parsed.password !== '' ||
      parsed.hash !== ''
    ) {
      throw new Error(
        `MICROSOFT_AI_${service}_URL must be a full ${secure.slice(0, -1)} endpoint URL`,
      );
    }
    if (
      parsed.protocol === local &&
      !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
    ) {
      throw new Error(`Microsoft AI ${service} requires TLS except on loopback endpoints`);
    }

    if (headers !== undefined) {
      if (apiKey !== undefined) throw new Error('Pass either apiKey or headers, not both');
      if (authHeader !== undefined) throw new Error('Pass either authHeader or headers, not both');
      this.headers = { ...headers };
    } else {
      let selectedHeader = 'Ocp-Apim-Subscription-Key';
      if (service === 'STT') {
        selectedHeader =
          authHeader ?? config.get('MICROSOFT_AI_STT_AUTH_HEADER') ?? 'Authorization';
        if (!['Authorization', 'api-key'].includes(selectedHeader)) {
          throw new Error(
            'MICROSOFT_AI_STT_AUTH_HEADER/authHeader must be Authorization or api-key',
          );
        }
      }
      const key = config.required(apiKey, `MICROSOFT_AI_${service}_API_KEY`);
      if (/[\x00-\x1f\x7f]/.test(key)) {
        throw new Error(`MICROSOFT_AI_${service}_API_KEY cannot contain control characters`);
      }
      this.headers = {
        [selectedHeader]: selectedHeader === 'Authorization' ? `Bearer ${key}` : key,
      };
    }
    if (!Object.keys(this.headers).some((name) => name.toLowerCase() === 'user-agent')) {
      this.headers['User-Agent'] = 'LiveKit Agents';
    }
    this.#fetch = options.fetch;
  }

  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    if (this.#closed) throw new Error('Microsoft AI provider is closed');
    return (this.#fetch ?? globalThis.fetch).call(globalThis, input, init);
  }

  close(): void {
    this.#closed = true;
  }
}
