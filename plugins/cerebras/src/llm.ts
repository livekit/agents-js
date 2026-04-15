// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { gzipSync } from 'node:zlib';
import { llm } from '@livekit/agents';
import { LLM as OpenAILLM } from '@livekit/agents-plugin-openai';
import { encode } from '@msgpack/msgpack';
import OpenAI from 'openai';
import type { CerebrasChatModels } from './models.js';

export interface LLMOptions {
  model: string | CerebrasChatModels;
  apiKey?: string;
  baseURL?: string;
  user?: string;
  temperature?: number;
  client?: OpenAI;
  toolChoice?: llm.ToolChoice;
  parallelToolCalls?: boolean;
  gzipCompression?: boolean;
  msgpackEncoding?: boolean;
}

const defaultLLMOptions: LLMOptions = {
  model: 'llama-4-scout-17b-16e-instruct',
  baseURL: 'https://api.cerebras.ai/v1',
  gzipCompression: true,
  msgpackEncoding: true,
};

/**
 * Create a custom fetch that compresses request payloads via msgpack and/or gzip.
 *
 * @see https://inference-docs.cerebras.ai/payload-optimization
 */
function createCompressedFetch(opts: {
  useMsgpack: boolean;
  useGzip: boolean;
}): typeof globalThis.fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (init?.method === 'POST' && init.body && typeof init.body === 'string') {
      const headers = new Headers(init.headers);

      let body: Uint8Array;
      if (opts.useMsgpack) {
        body = encode(JSON.parse(init.body));
        headers.set('Content-Type', 'application/vnd.msgpack');
      } else {
        body = new TextEncoder().encode(init.body);
      }

      if (opts.useGzip) {
        body = gzipSync(body, { level: 5 });
        headers.set('Content-Encoding', 'gzip');
      }

      return globalThis.fetch(input, { ...init, body: Buffer.from(body), headers });
    }
    return globalThis.fetch(input, init);
  };
}

export class LLM extends OpenAILLM {
  constructor(opts: Partial<LLMOptions> = {}) {
    const merged = { ...defaultLLMOptions, ...opts };

    merged.apiKey = merged.apiKey || process.env.CEREBRAS_API_KEY;
    if (merged.apiKey === undefined && !merged.client) {
      throw new Error(
        'Cerebras API key is required, either as an argument or as $CEREBRAS_API_KEY',
      );
    }

    if (!merged.client && (merged.gzipCompression || merged.msgpackEncoding)) {
      merged.client = new OpenAI({
        apiKey: merged.apiKey,
        baseURL: merged.baseURL,
        fetch: createCompressedFetch({
          useMsgpack: merged.msgpackEncoding ?? true,
          useGzip: merged.gzipCompression ?? true,
        }),
      });
    }

    super(merged);
  }

  override label(): string {
    return 'cerebras.LLM';
  }
}
