// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { log } from '@livekit/agents';

const TRUSS_URL_TEMPLATE = (modelId: string) =>
  `wss://model-${modelId}.api.baseten.co/environments/production/websocket`;
const CHAIN_URL_TEMPLATE = (chainId: string) =>
  `wss://chain-${chainId}.api.baseten.co/environments/production/websocket`;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/** Resolve a Qwen3 WebSocket endpoint using Baseten's endpoint precedence rules. */
export function resolveEndpoint(
  modelEndpoint: string | undefined,
  modelId: string | undefined,
  chainId: string | undefined,
  envVar: string,
): string {
  const endpoint =
    modelEndpoint ||
    (modelId ? TRUSS_URL_TEMPLATE(modelId) : undefined) ||
    (chainId ? CHAIN_URL_TEMPLATE(chainId) : undefined) ||
    process.env[envVar];

  if (!endpoint) {
    throw new Error(
      `An endpoint is required: pass modelEndpoint, modelId, or chainId, or set ${envVar}.`,
    );
  }
  if (!endpoint.startsWith('wss://') && !endpoint.startsWith('ws://')) {
    throw new Error(
      `This model is served over WebSocket only; got ${JSON.stringify(endpoint)}. Endpoints look like wss://model-<id>.api.baseten.co/environments/production/websocket`,
    );
  }

  const hostname = endpoint.startsWith('ws://')
    ? new URL(endpoint).hostname.replace(/^\[|\]$/g, '')
    : undefined;
  if (hostname !== undefined && !LOOPBACK_HOSTS.has(hostname)) {
    log().warn(
      { endpoint },
      'endpoint is plaintext ws://: the Baseten API key and all audio will be sent unencrypted. Use wss:// for any non-local host.',
    );
  }

  return endpoint;
}
