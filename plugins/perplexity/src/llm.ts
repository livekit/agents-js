// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { llm } from '@livekit/agents';
import { LLM as OpenAILLM } from '@livekit/agents-plugin-openai';
import OpenAI from 'openai';
import type { PerplexityChatModels } from './models.js';

/** @public */
export const PERPLEXITY_BASE_URL = 'https://api.perplexity.ai';

const ATTRIBUTION_HEADER = {
  'X-Pplx-Integration': `livekit-agents/${__PACKAGE_VERSION__}`,
};

/** @public */
export interface LLMOptions {
  model: string | PerplexityChatModels;
  apiKey?: string;
  baseURL?: string;
  client?: OpenAI;
  user?: string;
  temperature?: number;
  toolChoice?: llm.ToolChoice;
  parallelToolCalls?: boolean;
  topP?: number;
}

const defaultLLMOptions: LLMOptions = {
  model: 'sonar-pro',
  baseURL: PERPLEXITY_BASE_URL,
};

/**
 * Create a new instance of Perplexity LLM.
 *
 * @public
 */
export class LLM extends OpenAILLM {
  private readonly _client: OpenAI;
  private readonly _opts: LLMOptions;

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
      strictToolSchema: false,
    });

    this._client = client;
    this._opts = merged;
  }

  override label(): string {
    return 'perplexity.LLM';
  }

  override get provider(): string {
    return 'Perplexity';
  }
}
