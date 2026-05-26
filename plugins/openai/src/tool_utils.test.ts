// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { llm } from '@livekit/agents';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { toResponsesTools } from './tool_utils.js';
import { CodeInterpreter, FileSearch, WebSearch } from './tools.js';

describe('toResponsesTools', () => {
  it('serializes function tools', () => {
    const fn = llm.tool({
      name: 'lookup_weather',
      description: 'Look up weather',
      parameters: z.object({ city: z.string() }),
      execute: async () => 'sunny',
    });

    expect(toResponsesTools(new llm.ToolContext([fn]), true)).toEqual([
      {
        type: 'function',
        name: 'lookup_weather',
        description: 'Look up weather',
        parameters: {
          $schema: 'http://json-schema.org/draft-07/schema#',
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city'],
          additionalProperties: false,
        },
        strict: true,
      },
    ]);
  });

  it('serializes OpenAI provider tools', () => {
    const tools = toResponsesTools(
      new llm.ToolContext([
        new WebSearch({
          filters: { allowed_domains: ['docs.livekit.io'] },
          searchContextSize: 'low',
          userLocation: { type: 'approximate', country: 'US' },
        }),
        new FileSearch({
          vectorStoreIds: ['vs_123'],
          maxNumResults: 3,
          rankingOptions: { ranker: 'auto' },
        }),
        new CodeInterpreter({ container: { type: 'auto', file_ids: ['file_123'] } }),
      ]),
      false,
    );

    expect(tools).toEqual([
      {
        type: 'web_search',
        search_context_size: 'low',
        filters: { allowed_domains: ['docs.livekit.io'] },
        user_location: { type: 'approximate', country: 'US' },
      },
      {
        type: 'file_search',
        vector_store_ids: ['vs_123'],
        max_num_results: 3,
        ranking_options: { ranker: 'auto' },
      },
      { type: 'code_interpreter', container: { type: 'auto', file_ids: ['file_123'] } },
    ]);
  });

  it('ignores non-OpenAI provider tools', () => {
    class OtherProviderTool extends llm.ProviderTool {}

    expect(
      toResponsesTools(new llm.ToolContext([new OtherProviderTool({ id: 'other' })]), false),
    ).toBeUndefined();
  });
});
