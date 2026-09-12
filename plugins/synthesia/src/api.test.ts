// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { DEFAULT_API_CONNECT_OPTIONS } from '@livekit/agents';
import { describe, expect, it, vi } from 'vitest';
import { SESSION_PATH, SynthesiaAPI } from './api.js';
import { ErrorType, SynthesiaError } from './errors.js';

const API_URL = 'https://api.example';
const REQUEST = {
  avatarIds: ['avatar-1'],
  livekitUrl: 'wss://room.livekit.cloud',
  livekitToken: 'lk-token-secret',
};
const NO_SLEEP = { ...DEFAULT_API_CONNECT_OPTIONS, retryIntervalMs: 0 };

function response(status: number, body?: unknown, headers?: Record<string, string>): Response {
  return new Response(body === undefined ? '' : JSON.stringify(body), { status, headers });
}

function client(outcomes: Array<Response | Error>, connOptions = NO_SLEEP) {
  const fetch = vi.fn(async () => {
    const outcome = outcomes.shift();
    if (outcome instanceof Error) throw outcome;
    return outcome!;
  });
  return {
    api: new SynthesiaAPI({ apiKey: 'sk-secret-key', apiUrl: API_URL, fetch, connOptions }),
    fetch,
  };
}

function problem(
  code: string,
  status: number,
  options: { detail?: unknown; withCode?: boolean; requestId?: string } = {},
) {
  return {
    type: `https://developers.synthesia.io/errors/${code}`,
    title: 'Problem title',
    status,
    ...(options.withCode === false ? {} : { code }),
    ...(options.detail === undefined ? {} : { detail: options.detail }),
    ...(options.requestId ? { requestId: options.requestId } : {}),
  };
}

describe('SynthesiaAPI', () => {
  it.each([{ id: 'ses_1' }, { session_id: 'ses_2' }])(
    'accepts published session id shapes',
    async (body) => {
      const { api } = client([response(201, body)]);
      await expect(api.startSession(REQUEST)).resolves.toEqual({
        sessionId: body.id ?? body.session_id,
      });
    },
  );

  it('uses the published URL, authorization, and wire payload', async () => {
    const { api, fetch } = client([response(201, { id: 'ses_1' })]);
    await api.startSession({ ...REQUEST, avatarIds: ['ada-uuid', 'av_prefixed'] });
    expect(fetch).toHaveBeenCalledWith(
      API_URL + SESSION_PATH,
      expect.objectContaining({
        method: 'POST',
        headers: { Authorization: 'sk-secret-key', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          avatarIds: ['av_ada-uuid', 'av_prefixed'],
          livekitUrl: REQUEST.livekitUrl,
          livekitToken: REQUEST.livekitToken,
        }),
      }),
    );
  });

  it.each([
    ['validation_error', 400, ErrorType.INVALID_SESSION_REQUEST],
    ['unknown_reference', 404, ErrorType.UNKNOWN_AVATAR],
    ['quota_exceeded', 402, ErrorType.QUOTA_EXCEEDED],
    ['rate_limited', 429, ErrorType.RATE_LIMITED],
    ['unauthorized', 401, ErrorType.AUTH],
    ['invalid_api_key', 401, ErrorType.AUTH],
    ['unknown_avatar', 404, ErrorType.UNKNOWN_AVATAR],
    ['avatar_not_accessible', 404, ErrorType.UNKNOWN_AVATAR],
    ['invalid_token', 400, ErrorType.INVALID_ROOM_TOKEN],
    ['invalid_livekit_credentials', 401, ErrorType.LIVEKIT_CREDENTIALS_REJECTED],
    ['unauthenticated', 401, ErrorType.AUTH],
    ['not_authorized', 403, ErrorType.AUTH],
    ['forbidden', 403, ErrorType.AUTH],
    ['insufficient_scope', 403, ErrorType.AUTH],
    ['feature_not_in_plan', 403, ErrorType.FEATURE_NOT_IN_PLAN],
    ['payment_required', 402, ErrorType.QUOTA_EXCEEDED],
    ['concurrency_limit', 429, ErrorType.CONCURRENCY_LIMIT],
    ['concurrency_limit_exceeded', 429, ErrorType.CONCURRENCY_LIMIT],
  ] as const)('maps %s to %s', async (code, status, expected) => {
    const { api } = client([response(status, { error: { code, message: 'nope' } })]);
    await expect(api.startSession(REQUEST)).rejects.toMatchObject({ type: expected, status });
  });

  it('uses problem detail, status, request id, and does not guess unknown problem codes', async () => {
    const body = problem('new_backend_code', 404, {
      detail: 'Detailed failure',
      requestId: 'req_1',
    });
    const { api } = client([response(404, body)]);
    await expect(api.startSession(REQUEST)).rejects.toMatchObject({
      message: 'Detailed failure',
      type: null,
      body,
      status: 404,
      requestId: 'req_1',
    });
  });

  it('falls back from an unusable problem detail to title and from no code to status', async () => {
    const { api } = client([
      response(404, problem('not_found', 404, { detail: [{ msg: 'x' }], withCode: false })),
    ]);
    await expect(api.startSession(REQUEST)).rejects.toMatchObject({
      message: 'Problem title',
      type: ErrorType.UNKNOWN_AVATAR,
    });
  });

  it.each([
    [{ error: 'Forbidden', context: 'User is not authenticated' }, 'User is not authenticated'],
    [{ error: 'Forbidden' }, 'Forbidden'],
    [
      {
        code: 'validation_error',
        context: { livekit_url: ['Must be a wss:// URL'] },
        error: 'InvalidSessionRequestError',
      },
      'validation_error: {"livekit_url":["Must be a wss:// URL"]}',
    ],
  ])('renders legacy error bodies', async (body, message) => {
    const { api } = client([response(403, body)]);
    await expect(api.startSession(REQUEST)).rejects.toMatchObject({ message, body });
  });

  it.each([
    [{ 'Retry-After': '12' }, { error: { code: 'rate_limited' } }, 12_000],
    [{}, { error: { code: 'rate_limited' }, retry_after: 3.5 }, 3_500],
    [{}, { error: { code: 'rate_limited', retry_after: 9 } }, 9_000],
  ] as const)('reads retry-after in JS milliseconds', async (headers, body, expected) => {
    const { api } = client([response(429, body, headers)]);
    await expect(api.startSession(REQUEST)).rejects.toMatchObject({ retryAfter: expected });
  });

  it('does not retry terminal errors', async () => {
    const { api, fetch } = client([response(401, { error: { code: 'unauthorized' } })]);
    await expect(api.startSession(REQUEST)).rejects.toBeInstanceOf(SynthesiaError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('retries 5xx and transport failures and can recover', async () => {
    const { api, fetch } = client([
      new TypeError('network down'),
      response(503),
      response(200, { session_id: 'sess_ok' }),
    ]);
    await expect(api.startSession(REQUEST)).resolves.toEqual({ sessionId: 'sess_ok' });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('reports the final 5xx detail and request id when retries are exhausted', async () => {
    const body = problem('service_unavailable', 503, {
      detail: 'Retry later',
      requestId: 'req_last',
    });
    const { api } = client([response(503, body)], { ...NO_SLEEP, maxRetry: 0 });
    await expect(api.startSession(REQUEST)).rejects.toMatchObject({
      message:
        'could not start a Synthesia session; last attempt: HTTP 503: Retry later (request req_last)',
      type: ErrorType.CONNECTION,
      body,
      status: 503,
      requestId: 'req_last',
    });
  });

  it('retries when a response body fails while being read', async () => {
    const truncated = {
      status: 503,
      ok: false,
      text: vi.fn().mockRejectedValue(new Error('truncated body')),
      headers: new Headers(),
    } as unknown as Response;
    const { api, fetch } = client([truncated, response(200, { id: 'sess_ok' })], {
      ...NO_SLEEP,
      maxRetry: 1,
    });
    await expect(api.startSession(REQUEST)).resolves.toEqual({ sessionId: 'sess_ok' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('lets the final mixed outcome decide the exhausted message', async () => {
    const first = client([new TypeError('offline'), response(503, { message: 'unavailable' })], {
      ...NO_SLEEP,
      maxRetry: 1,
    });
    await expect(first.api.startSession(REQUEST)).rejects.toMatchObject({
      message:
        'could not start a Synthesia session after 2 attempts; last attempt: HTTP 503: unavailable',
      status: 503,
    });

    const second = client([response(503), new TypeError('offline')], {
      ...NO_SLEEP,
      maxRetry: 1,
    });
    await expect(second.api.startSession(REQUEST)).rejects.toMatchObject({
      message:
        'could not start a Synthesia session after 2 attempts; last attempt: connection error',
      status: null,
    });
  });

  it('rejects malformed successful responses', async () => {
    const { api } = client([response(200, { unexpected: true })]);
    await expect(api.startSession(REQUEST)).rejects.toThrow(
      'Synthesia response did not contain a session id',
    );
  });
});
