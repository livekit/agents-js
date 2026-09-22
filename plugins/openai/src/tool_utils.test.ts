// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { llm } from '@livekit/agents';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { logProviderToolExecutions, toResponsesTools } from './tool_utils.js';
import { CodeInterpreter, FileSearch, OpenAITool, WebSearch } from './tools.js';

describe('toResponsesTools', () => {
  it('sorts function tools before provider tools without making optional parameters strict', () => {
    const makeTool = (name: string) =>
      llm.tool({
        name,
        description: 'Look up weather',
        parameters: z.object({ city: z.string().optional() }),
        execute: async () => 'sunny',
      });

    expect(
      toResponsesTools(
        new llm.ToolContext([makeTool('zulu'), new WebSearch(), makeTool('alpha')]),
        false,
      ),
    ).toEqual([
      ...['alpha', 'zulu'].map((name) => ({
        type: 'function',
        name,
        description: 'Look up weather',
        parameters: {
          $schema: 'http://json-schema.org/draft-07/schema#',
          type: 'object',
          properties: { city: { type: 'string' } },
          additionalProperties: false,
        },
      })),
      { type: 'web_search', search_context_size: 'medium' },
    ]);
  });

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

  it('omits the code interpreter container when unset', () => {
    expect(toResponsesTools(new llm.ToolContext([new CodeInterpreter()]), false)).toEqual([
      { type: 'code_interpreter' },
    ]);
  });

  it('ignores non-OpenAI provider tools by default', () => {
    class OtherProviderTool extends llm.ProviderTool {
      toToolConfig() {
        return { type: 'web_search' };
      }
    }

    expect(
      toResponsesTools(new llm.ToolContext([new OtherProviderTool({ id: 'other' })]), false),
    ).toBeUndefined();
  });

  it('serializes provider tools matching providerToolType', () => {
    class XAITool extends llm.ProviderTool {
      toToolConfig() {
        return { type: 'web_search', allowed_domains: ['x.com'] };
      }
    }

    expect(
      toResponsesTools(
        new llm.ToolContext([new XAITool({ id: 'xai_web_search' })]),
        false,
        XAITool,
      ),
    ).toEqual([{ type: 'web_search', allowed_domains: ['x.com'] }]);
  });

  it('still serializes OpenAI tools when providerToolType is OpenAITool', () => {
    expect(toResponsesTools(new llm.ToolContext([new WebSearch()]), false, OpenAITool)).toEqual([
      { type: 'web_search', search_context_size: 'medium' },
    ]);
  });
});

describe('logProviderToolExecutions', () => {
  it('logs only server-side provider tool items', () => {
    const info = vi.fn();
    logProviderToolExecutions(
      [
        { type: 'message' },
        { type: 'reasoning' },
        { type: 'function_call' },
        { type: 'function_call_output' },
        { type: 'web_search_call', id: 'ws_1' },
        { type: 'custom_tool_call', name: 'x_keyword_search' },
      ],
      { info },
    );

    expect(info).toHaveBeenCalledTimes(2);
    expect(info).toHaveBeenNthCalledWith(
      1,
      { tool_type: 'web_search_call', result: { type: 'web_search_call', id: 'ws_1' } },
      'provider tool executed',
    );
    expect(info).toHaveBeenNthCalledWith(
      2,
      {
        tool_type: 'custom_tool_call',
        result: { type: 'custom_tool_call', name: 'x_keyword_search' },
      },
      'provider tool executed',
    );
  });

  it('no-ops on missing output', () => {
    const info = vi.fn();
    logProviderToolExecutions(undefined, { info });
    expect(info).not.toHaveBeenCalled();
  });
});
