// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Baseten LLM plugin for LiveKit Agents
 * Configures the OpenAI plugin to work with Baseten's OpenAI-compatible API
 */
import { LLM as OpenAILLM } from '@livekit/agents-plugin-openai';
import type { BasetenLLMOptions } from './types.js';

export class LLM extends OpenAILLM {
  constructor(opts: BasetenLLMOptions) {
    const apiKey = opts.apiKey ?? process.env.BASETEN_API_KEY;
    if (!apiKey) {
      throw new Error(
        'Baseten API key is required. Set BASETEN_API_KEY environment variable or pass apiKey in options.',
      );
    }

    if (!opts.model) {
      throw new Error(
        'Model is required. Please specify a model name (e.g., "openai/gpt-4o-mini").',
      );
    }

    const model = opts.model;

    // Configure the OpenAI plugin with Baseten's endpoint
    super({
      model,
      apiKey,
      baseURL: 'https://inference.baseten.co/v1',
      temperature: opts.temperature,
      user: opts.user,
      maxCompletionTokens: opts.maxTokens,
      toolChoice: opts.toolChoice,
      parallelToolCalls: opts.parallelToolCalls,
    });
  }

  label(): string {
    return 'baseten.LLM';
  }
}
