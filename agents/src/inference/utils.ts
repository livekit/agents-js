// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AccessToken } from 'livekit-server-sdk';
import { WebSocket } from 'ws';
import { APIConnectionError, APIStatusError } from '../index.js';

export type AnyString = string & NonNullable<unknown>;

/** Default production inference URL */
export const DEFAULT_INFERENCE_URL = 'https://agent-gateway.livekit.cloud/v1';

/** Staging inference URL */
export const STAGING_INFERENCE_URL = 'https://agent-gateway.staging.livekit.cloud/v1';

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

export async function connectWs(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<WebSocket> {
  return new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(url, { headers: headers });

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
