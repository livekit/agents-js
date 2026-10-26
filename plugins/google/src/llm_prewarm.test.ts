// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { GoogleAuth } from 'google-auth-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LLM } from './llm.js';

function withTimeout<T>(promise: Promise<T>, timeoutMs = 500): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error('timed out waiting for SDK request')), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

describe('Google LLM prewarm', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('acquires a Vertex token before the cancellable models-list request', async () => {
    vi.stubEnv('GOOGLE_API_KEY', '');
    vi.stubEnv('GOOGLE_APPLICATION_CREDENTIALS', '');
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', '');
    vi.stubEnv('GOOGLE_CLOUD_LOCATION', '');
    vi.stubEnv('GOOGLE_GENAI_USE_VERTEXAI', '');

    const events: string[] = [];
    const getAccessToken = vi.fn(async () => {
      events.push('token');
      return { token: 'test-access-token' };
    });
    const authClient = {
      getAccessToken,
      getRequestHeaders: vi.fn(async () => {
        const { token } = await getAccessToken();
        return new Headers({ authorization: `Bearer ${token}` });
      }),
    };
    const getClient = vi
      .spyOn(GoogleAuth.prototype, 'getClient')
      .mockResolvedValue(authClient as never);

    let fetchSignal: AbortSignal | undefined;
    let resolveFetchStarted!: () => void;
    const fetchStarted = new Promise<void>((resolve) => {
      resolveFetchStarted = resolve;
    });
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        events.push('models-list');
        fetchSignal = init?.signal instanceof AbortSignal ? init.signal : undefined;
        resolveFetchStarted();
        return await new Promise<Response>((_resolve, reject) => {
          if (fetchSignal?.aborted) {
            reject(new DOMException('aborted', 'AbortError'));
            return;
          }
          fetchSignal?.addEventListener(
            'abort',
            () => reject(new DOMException('aborted', 'AbortError')),
            { once: true },
          );
        });
      },
    );
    vi.stubGlobal('fetch', fetchMock);

    const llm = new LLM({
      model: 'gemini-2.5-flash',
      vertexai: true,
      project: 'test-project',
      location: 'test-location',
    });

    try {
      llm.prewarm();
      await withTimeout(fetchStarted);

      expect(getClient).toHaveBeenCalledTimes(1);
      expect(getAccessToken).toHaveBeenCalledTimes(1);
      expect(events).toEqual(['token', 'models-list']);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const [input, init] = fetchMock.mock.calls[0]!;
      const url = new URL(String(input));
      expect(url.pathname).toContain('/publishers/google/models');
      expect(url.searchParams.get('pageSize')).toBe('1');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-access-token');
      expect(fetchSignal?.aborted).toBe(false);
    } finally {
      await llm.aclose();
    }

    expect(fetchSignal?.aborted).toBe(true);
  });
});
