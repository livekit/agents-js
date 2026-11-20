// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { type APIConnectOptions, APIConnectionError, APIStatusError, voice } from '@livekit/agents';
import type { Room } from '@livekit/rtc-node';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AvatarSession } from './avatar.js';

const connOptions: APIConnectOptions = { maxRetry: 2, retryIntervalMs: 0, timeoutMs: 1000 };

function scriptedFetch(script: Array<number | Error>) {
  const steps = [...script];
  return vi.spyOn(global, 'fetch').mockImplementation(async () => {
    const step = steps.length > 1 ? steps.shift()! : steps[0]!;
    if (step instanceof Error) throw step;
    return {
      ok: step < 400,
      status: step,
      text: async () => `status ${step}`,
    } as Response;
  });
}

function startAgent(avatar: AvatarSession): Promise<void> {
  return (
    avatar as unknown as {
      startAgent(livekitUrl: string, livekitToken: string): Promise<void>;
    }
  ).startAgent('wss://livekit.test', 'token');
}

function avatar(): AvatarSession {
  return new AvatarSession({
    apiKey: 'test-key',
    apiUrl: 'http://bey.test',
    connOptions,
  });
}

describe('Bey AvatarSession', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls base AvatarSession.start first', async () => {
    const sentinel = new Error('super-start-called');
    const superStartSpy = vi
      .spyOn(voice.AvatarSession.prototype, 'start')
      .mockRejectedValue(sentinel);

    const avatar = new AvatarSession({
      apiKey: 'bey-test-key',
    });

    await expect(
      avatar.start(
        { _started: false, output: { audio: null } } as unknown as voice.AgentSession,
        {} as Room,
      ),
    ).rejects.toThrow('super-start-called');
    expect(superStartSpy).toHaveBeenCalledTimes(1);
  });

  it('does not retry client errors and keeps the provider status', async () => {
    const fetchMock = scriptedFetch([401]);

    const error = await startAgent(avatar()).catch((error: unknown) => error);

    expect(error).toBeInstanceOf(APIStatusError);
    expect((error as APIStatusError).statusCode).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries server errors until success', async () => {
    const fetchMock = scriptedFetch([503, 503, 200]);

    await startAgent(avatar());

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('raises a persistent server error after maxRetry retries', async () => {
    const fetchMock = scriptedFetch([503]);

    const error = await startAgent(avatar()).catch((error: unknown) => error);

    expect(error).toBeInstanceOf(APIStatusError);
    expect((error as APIStatusError).statusCode).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(connOptions.maxRetry + 1);
  });

  it('retries network errors and chains the final error', async () => {
    const networkError = new TypeError('connection refused');
    const fetchMock = scriptedFetch([networkError]);

    const error = await startAgent(avatar()).catch((error: unknown) => error);

    expect(error).toBeInstanceOf(APIConnectionError);
    expect((error as APIConnectionError).cause).toBe(networkError);
    expect(fetchMock).toHaveBeenCalledTimes(connOptions.maxRetry + 1);
  });
});
