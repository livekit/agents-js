// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AccessToken } from 'livekit-server-sdk';
import { WebSocket } from 'ws';
import { APIConnectionError, APIStatusError } from '../index.js';

export type CustomModelType = `custom/${string}`;

/**
 * Get the model name from a model string with type inference.
 *
 * Example:
 * ```ts
 * // inferred as 'llama-3.1-8b-instruct'
 * const model = getModelName('custom/llama-3.1-8b-instruct');
 *
 * // inferred as 'azure/gpt-4.1'
 * const model2 = getModelName('azure/gpt-4.1');
 * ```
 * @param model - The model string.
 * @returns The model name.
 */
export function getModelName<TModel extends string>(
  model: TModel,
): TModel extends `custom/${infer TModelName}` ? TModelName : TModel {
  if (model.startsWith('custom/')) {
    return model.split('/')[1] as any; // eslint-disable-line @typescript-eslint/no-explicit-any
  }
  return model as any; // eslint-disable-line @typescript-eslint/no-explicit-any
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
