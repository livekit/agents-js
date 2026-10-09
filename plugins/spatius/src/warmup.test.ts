// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { JobProcess, initializeLogger } from '@livekit/agents';
import { prewarm as sdkPrewarm } from '@spatius/server-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { prewarm } from './warmup.js';

vi.mock('@spatius/server-sdk', () => ({ prewarm: vi.fn() }));
initializeLogger({ pretty: false, level: 'silent' });

describe('Spatius prewarm', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetAllMocks();
  });

  it('skips when no app is configured', async () => {
    vi.stubEnv('SPATIUS_APP_ID', '');
    await prewarm(new JobProcess());
    expect(sdkPrewarm).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    'forwards endpoint overrides and prefetch=%s',
    async (prefetchSessionToken) => {
      vi.stubEnv('SPATIUS_APP_ID', 'app');
      vi.stubEnv('SPATIUS_API_KEY', 'key');
      vi.stubEnv('SPATIUS_REGION', 'cn-north');
      vi.stubEnv('SPATIUS_CONSOLE_ENDPOINT', 'https://console.example.com');
      vi.stubEnv('SPATIUS_INGRESS_ENDPOINT', 'wss://ingress.example.com');
      await prewarm(new JobProcess(), { prefetchSessionToken });
      expect(sdkPrewarm).toHaveBeenCalledWith({
        appId: 'app',
        apiKey: 'key',
        region: 'cn-north',
        consoleEndpointUrl: 'https://console.example.com',
        ingressEndpointUrl: 'wss://ingress.example.com',
        timeoutMs: 4000,
        prefetchSessionToken,
      });
    },
  );

  it('warms without a key and never rejects a failed SDK warmup', async () => {
    vi.stubEnv('SPATIUS_APP_ID', 'app');
    vi.stubEnv('SPATIUS_API_KEY', '');
    vi.mocked(sdkPrewarm).mockRejectedValueOnce(new Error('offline'));
    await expect(prewarm(new JobProcess())).resolves.toBeUndefined();
    expect(sdkPrewarm).toHaveBeenCalledWith(
      expect.objectContaining({ prefetchSessionToken: false }),
    );
  });
});
