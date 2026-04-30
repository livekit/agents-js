// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { initializeLogger, voice } from '@livekit/agents';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AvatarSession } from './avatar.js';

describe('LemonSlice AvatarSession', () => {
  beforeEach(() => {
    initializeLogger({ pretty: false });
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('merges extraPayload into the session creation request body', async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ session_id: 'test-session-id' }),
    } as Response);

    const avatar = new AvatarSession({
      apiKey: 'test-api-key',
      agentImageUrl: 'https://example.com/avatar.png',
      extraPayload: {
        aspect_ratio: '9x16',
      },
    });

    await (
      avatar as unknown as {
        startAgent(livekitUrl: string, livekitToken: string): Promise<void>;
      }
    ).startAgent('wss://livekit.example.com', 'livekit-token');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://lemonslice.com/api/liveai/sessions',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          transport_type: 'livekit',
          properties: {
            livekit_url: 'wss://livekit.example.com',
            livekit_token: 'livekit-token',
          },
          agent_image_url: 'https://example.com/avatar.png',
          aspect_ratio: '9x16',
        }),
      }),
    );
  });

  it('keeps the request body unchanged when extraPayload is omitted', async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ session_id: 'test-session-id' }),
    } as Response);

    const avatar = new AvatarSession({
      apiKey: 'test-api-key',
      agentImageUrl: 'https://example.com/avatar.png',
    });

    await (
      avatar as unknown as {
        startAgent(livekitUrl: string, livekitToken: string): Promise<void>;
      }
    ).startAgent('wss://livekit.example.com', 'livekit-token');

    const requestInit = mockFetch.mock.calls[0]?.[1];
    const body = JSON.parse(String(requestInit?.body));

    expect(body).toEqual({
      transport_type: 'livekit',
      properties: {
        livekit_url: 'wss://livekit.example.com',
        livekit_token: 'livekit-token',
      },
      agent_image_url: 'https://example.com/avatar.png',
    });
    expect(body).not.toHaveProperty('aspect_ratio');
  });

  it('calls base AvatarSession.start first', async () => {
    const sentinel = new Error('super-start-called');
    const superStartSpy = vi
      .spyOn(voice.AvatarSession.prototype, 'start')
      .mockRejectedValue(sentinel);

    const avatar = new AvatarSession({
      apiKey: 'test-api-key',
      agentImageUrl: 'https://example.com/avatar.png',
    });

    await expect(
      avatar.start({ _started: false, output: { audio: null } } as any, {} as any),
    ).rejects.toThrow('super-start-called');
    expect(superStartSpy).toHaveBeenCalledTimes(1);
  });
});
