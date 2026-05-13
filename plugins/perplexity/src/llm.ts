// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { llm } from '@livekit/agents';
import { LLM as OpenAILLM } from '@livekit/agents-plugin-openai';
import OpenAI from 'openai';
import type { PerplexityChatModels } from './models.js';

/** @public */
export const PERPLEXITY_BASE_URL = 'https://api.perplexity.ai';

/** @public */
export interface LLMOptions {
  model: string | PerplexityChatModels;
  apiKey?: string;
  baseURL?: string;
  client?: OpenAI;
  user?: string;
  temperature?: number;
  topP?: number;
  toolChoice?: llm.ToolChoice;
  parallelToolCalls?: boolean;
}

const defaultLLMOptions: LLMOptions = {
  model: 'sonar-pro',
  baseURL: PERPLEXITY_BASE_URL,
};

/** @public */
export class LLM extends OpenAILLM {
  #topP?: number;
  #extraHeaders = {
    'X-Pplx-Integration': `livekit-agents/${__PACKAGE_VERSION__}`,
  };

  constructor(opts: Partial<LLMOptions> = {}) {
    const merged = { ...defaultLLMOptions, ...opts };
    const apiKey = merged.apiKey ?? process.env.PERPLEXITY_API_KEY;

    if (!apiKey && !merged.client) {
      throw new Error(
        'Perplexity API key is required, either as an argument or as $PERPLEXITY_API_KEY',
      );
    }

    super({
      ...merged,
      apiKey,
      client:
        merged.client ??
        new OpenAI({
          apiKey,
          baseURL: merged.baseURL,
        }),
      strictToolSchema: false,
    });

    this.#topP = merged.topP;
  }

  override label(): string {
    return 'perplexity.LLM';
  }

  override get provider(): string {
    return 'Perplexity';
  }

  override chat(opts: Parameters<OpenAILLM['chat']>[0]): ReturnType<OpenAILLM['chat']> {
    const extraKwargs = { ...opts.extraKwargs };
    if (this.#topP !== undefined) {
      extraKwargs.top_p = this.#topP;
    }

    extraKwargs.extra_headers = {
      ...((extraKwargs.extra_headers as Record<string, string> | undefined) ?? {}),
      ...this.#extraHeaders,
    };

    return super.chat({ ...opts, extraKwargs });
  }
}
