// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { type JobProcess, log } from '@livekit/agents';
import { prewarm as sdkPrewarm } from '@spatius/server-sdk';

/** Options for process-local region and session-token prefetching.
 * @public
 */
export interface PrewarmOptions {
  /** Defaults to true. Disable if your backend uses single-use session tokens. */
  prefetchSessionToken?: boolean;
}

/**
 * Best-effort Spatius warmup for defineAgent's prewarm hook. Reads the same
 * SPATIUS_* environment variables as AvatarSession. Failures never prevent startup.
 * @public
 */
export async function prewarm(_proc: JobProcess, options: PrewarmOptions = {}): Promise<void> {
  const appId = process.env.SPATIUS_APP_ID;
  if (!appId) return;
  const apiKey = process.env.SPATIUS_API_KEY;
  try {
    await sdkPrewarm({
      appId,
      apiKey,
      region: process.env.SPATIUS_REGION ?? 'auto',
      consoleEndpointUrl: process.env.SPATIUS_CONSOLE_ENDPOINT,
      ingressEndpointUrl: process.env.SPATIUS_INGRESS_ENDPOINT,
      prefetchSessionToken: (options.prefetchSessionToken ?? true) && !!apiKey,
      timeoutMs: 4000,
    });
  } catch (error) {
    log().warn({ error }, 'Spatius warmup failed');
  }
}
