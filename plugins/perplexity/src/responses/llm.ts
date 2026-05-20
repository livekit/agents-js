// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { llm } from '@livekit/agents';
import { responses } from '@livekit/agents-plugin-openai';
import OpenAI from 'openai';
import type { PerplexityResponsesModels } from '../models.js';

/** @public */
export const PERPLEXITY_RESPONSES_BASE_URL = 'https://api.perplexity.ai/v1';

const ATTRIBUTION_HEADER = {
  'X-Pplx-Integration': `livekit-agents/${__PACKAGE_VERSION__}`,
};

/** @public */
export interface LLMOptions {
  model: string | PerplexityResponsesModels;
  apiKey?: string;
  baseURL?: string;
  client?: OpenAI;
  temperature?: number;
  parallelToolCalls?: boolean;
  toolChoice?: llm.ToolChoice;
  store?: boolean;
  metadata?: Record<string, string>;
  strictToolSchema?: boolean;
  serviceTier?: string;
  maxOutputTokens?: number;
}

const defaultLLMOptions: LLMOptions = {
  model: 'perplexity/sonar',
  baseURL: PERPLEXITY_RESPONSES_BASE_URL,
};

/**
 * Create a new instance of Perplexity Responses LLM.
 *
 * @public
 */
export class LLM extends responses.LLM {
  private readonly _client: OpenAI;
  private readonly _opts: LLMOptions & { useWebSocket: false };

  constructor(opts: Partial<LLMOptions> = {}) {
    const merged = { ...defaultLLMOptions, ...opts };

    merged.apiKey = merged.apiKey || process.env.PERPLEXITY_API_KEY;
    if (merged.apiKey === undefined && !merged.client) {
      throw new Error(
        'Perplexity API key is required, either as an argument or as $PERPLEXITY_API_KEY',
      );
    }

    const client =
      merged.client ||
      new OpenAI({
        apiKey: merged.apiKey,
        baseURL: merged.baseURL,
        defaultHeaders: ATTRIBUTION_HEADER,
        maxRetries: 0,
      });

    super({
      ...merged,
      client,
      useWebSocket: false,
    });

    this._client = client;
    this._opts = { ...merged, useWebSocket: false };
  }
}
