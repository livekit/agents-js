// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { ThrowsPromise } from '@livekit/throws-transformer/throws';
import { AccessToken } from 'livekit-server-sdk';
import type { IncomingMessage } from 'node:http';
import { WebSocket } from 'ws';
import { APIConnectionError, APIStatusError, APITimeoutError } from '../_exceptions.js';
import { getJobContext } from '../job.js';
import { version } from '../version.js';

export type AnyString = string & NonNullable<unknown>;

/** Scheduling class for an inference request. */
export type InferenceClass = 'priority' | 'standard' | 'low';

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

export function resolveCredentials(
  apiKey?: string,
  apiSecret?: string,
): { apiKey: string; apiSecret: string } {
  const resolvedApiKey =
    apiKey || process.env.LIVEKIT_INFERENCE_API_KEY || process.env.LIVEKIT_API_KEY;
  if (!resolvedApiKey) {
    throw new Error('apiKey is required: pass apiKey or set LIVEKIT_API_KEY');
  }

  const resolvedApiSecret =
    apiSecret || process.env.LIVEKIT_INFERENCE_API_SECRET || process.env.LIVEKIT_API_SECRET;
  if (!resolvedApiSecret) {
    throw new Error('apiSecret is required: pass apiSecret or set LIVEKIT_API_SECRET');
  }

  return { apiKey: resolvedApiKey, apiSecret: resolvedApiSecret };
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
 * Includes SDK version/platform, and optionally room/job/agent IDs from the current job context.
 * Includes X-LiveKit-Worker-Token when LIVEKIT_WORKER_TOKEN is set (hosted agents).
 * The job context's {@link JobContext.inferenceHeaders} are merged last and win.
 */
export function buildMetadataHeaders(inferenceClass?: InferenceClass): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': `livekit-agents-js/${version} (node ${process.version})`,
  };
  if (inferenceClass) {
    headers[INFERENCE_PRIORITY_HEADER] = inferenceClass;
  }

  const ctx = getJobContext(false);
  if (ctx) {
    const roomSid = ctx.job.room?.sid;
    if (roomSid) {
      headers['X-LiveKit-Room-Id'] = roomSid;
    }
    if (ctx.job.id) {
      headers['X-LiveKit-Job-Id'] = ctx.job.id;
    }
    // for hosted agents where job context is always present
    const workerToken = process.env.LIVEKIT_WORKER_TOKEN;
    if (workerToken) {
      headers['X-LiveKit-Worker-Token'] = workerToken;
    }
    // Only emit the agent SID once the room is connected: before connection the
    // local participant SID is unset/placeholder and would leak into requests.
    const agentSid = ctx.agent?.sid;
    if (ctx.room.isConnected && agentSid) {
      headers['X-LiveKit-Agent-Id'] = agentSid;
    }
    // merged last: what the job asserts about itself outranks what an individual
    // model was configured with.
    Object.assign(headers, ctx.inferenceHeaders);
  }

  return headers;
}

export async function connectWs(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
  inferenceClass?: InferenceClass,
): Promise<WebSocket> {
  return new ThrowsPromise<WebSocket, APIConnectionError | APIStatusError>((resolve, reject) => {
    const socket = new WebSocket(url, {
      headers: { ...buildMetadataHeaders(inferenceClass), ...headers },
    });

    let opened = false;

    const timeout = setTimeout(() => {
      socket.terminate();
      reject(new APITimeoutError({ message: 'Timeout connecting to LiveKit WebSocket' }));
    }, timeoutMs);

    const onOpen = () => {
      clearTimeout(timeout);
      opened = true;
      resolve(socket);
    };

    const onUnexpectedResponse = (_request: unknown, response: IncomingMessage) => {
      const statusCode = response.statusCode ?? -1;
      clearTimeout(timeout);
      reject(
        new APIStatusError({
          message: `Unexpected server response: ${statusCode}`,
          options: { statusCode },
        }),
      );
      socket.terminate();
    };

    const onError = () => {
      clearTimeout(timeout);
      reject(new APIConnectionError({ message: 'Error connecting to LiveKit WebSocket' }));
    };

    const onClose = () => {
      clearTimeout(timeout);
      if (!opened) {
        reject(
          new APIConnectionError({
            message: 'Connection closed unexpectedly',
          }),
        );
      }
    };
    socket.once('open', onOpen);
    socket.once('unexpected-response', onUnexpectedResponse);
    socket.once('error', onError);
    socket.once('close', onClose);
  });
}
