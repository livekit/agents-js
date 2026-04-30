// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { ThrowsPromise } from '@livekit/throws-transformer/throws';
import { AccessToken } from 'livekit-server-sdk';
import { WebSocket } from 'ws';
import { APIConnectionError, APIStatusError } from '../_exceptions.js';
import { getJobContext } from '../job.js';
import { version } from '../version.js';

export type AnyString = string & NonNullable<unknown>;

/** Default production inference URL */
export const DEFAULT_INFERENCE_URL = 'https://agent-gateway.livekit.cloud/v1';

/** Staging inference URL */
export const STAGING_INFERENCE_URL = 'https://agent-gateway.staging.livekit.cloud/v1';

/** LiveKit Agent Gateway routing header names. */
export const INFERENCE_PROVIDER_HEADER = 'X-LiveKit-Inference-Provider';
export const INFERENCE_PRIORITY_HEADER = 'X-LiveKit-Inference-Priority';

/**
 * Get the default inference URL based on the environment.
 *
 * Priority:
 * 1. LIVEKIT_INFERENCE_URL if set
 * 2. If LIVEKIT_URL contains '.staging.livekit.cloud', use staging gateway
 * 3. Otherwise, use production gateway
 */
export function getDefaultInferenceUrl(): string {
  const inferenceUrl = process.env.LIVEKIT_INFERENCE_URL;
  if (inferenceUrl) {
    return inferenceUrl;
  }

  const livekitUrl = process.env.LIVEKIT_URL || '';
  if (livekitUrl.includes('.staging.livekit.cloud')) {
    return STAGING_INFERENCE_URL;
  }

  return DEFAULT_INFERENCE_URL;
}

export async function createAccessToken(
  apiKey: string,
  apiSecret: string,
  ttl: number = 600,
): Promise<string> {
  const token = new AccessToken(apiKey, apiSecret, { identity: 'agent', ttl });
  token.addInferenceGrant({ perform: true });

  return await token.toJwt();
}

/**
 * Build metadata headers for inference requests.
 * Includes SDK version/platform, and optionally room/job IDs from the current job context.
 */
export function buildMetadataHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': `livekit-agents-js/${version} (node ${process.version})`,
  };

  const ctx = getJobContext(false);
  if (ctx) {
    const roomSid = ctx.job.room?.sid;
    if (roomSid) {
      headers['X-LiveKit-Room-Id'] = roomSid;
    }
    if (ctx.job.id) {
      headers['X-LiveKit-Job-Id'] = ctx.job.id;
    }
  }

  return headers;
}

export async function connectWs(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<WebSocket> {
  return new ThrowsPromise<WebSocket, APIConnectionError | APIStatusError>((resolve, reject) => {
    const socket = new WebSocket(url, { headers: { ...buildMetadataHeaders(), ...headers } });

    const timeout = setTimeout(() => {
      reject(new APIConnectionError({ message: 'Timeout connecting to LiveKit WebSocket' }));
    }, timeoutMs);

    const onOpen = () => {
      clearTimeout(timeout);
      resolve(socket);
    };

    const onError = (err: unknown) => {
      clearTimeout(timeout);
      if (err && typeof err === 'object' && 'code' in err && (err as any).code === 429) {
        reject(
          new APIStatusError({
            message: 'LiveKit gateway quota exceeded',
            options: { statusCode: 429 },
          }),
        );
      } else {
        reject(new APIConnectionError({ message: 'Error connecting to LiveKit WebSocket' }));
      }
    };

    const onClose = (code: number) => {
      clearTimeout(timeout);
      if (code !== 1000) {
        reject(
          new APIConnectionError({
            message: 'Connection closed unexpectedly',
          }),
        );
      }
    };
    socket.once('open', onOpen);
    socket.once('error', onError);
    socket.once('close', onClose);
  });
}
