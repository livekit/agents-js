// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { llm } from '@livekit/agents';

export class WebSearch {
  static create({
    filters,
    searchContextSize = 'medium',
    userLocation,
  }: {
    filters?: Record<string, unknown>;
    searchContextSize?: 'low' | 'medium' | 'high';
    userLocation?: Record<string, unknown>;
  } = {}): llm.ProviderDefinedTool {
    return llm.tool({
      id: 'openai_web_search',
      config: {
        type: 'web_search',
        search_context_size: searchContextSize,
        ...(userLocation !== undefined ? { user_location: userLocation } : {}),
        ...(filters !== undefined ? { filters } : {}),
      },
    });
  }
}

export class FileSearch {
  static create({
    vectorStoreIds = [],
    filters,
    maxNumResults,
    rankingOptions,
  }: {
    vectorStoreIds?: string[];
    filters?: Record<string, unknown>;
    maxNumResults?: number;
    rankingOptions?: Record<string, unknown>;
  } = {}): llm.ProviderDefinedTool {
    return llm.tool({
      id: 'openai_file_search',
      config: {
        type: 'file_search',
        vector_store_ids: vectorStoreIds,
        ...(filters !== undefined ? { filters } : {}),
        ...(maxNumResults !== undefined ? { max_num_results: maxNumResults } : {}),
        ...(rankingOptions !== undefined ? { ranking_options: rankingOptions } : {}),
      },
    });
  }
}

export class CodeInterpreter {
  static create({
    container,
  }: {
    container?: string | Record<string, unknown> | null;
  } = {}): llm.ProviderDefinedTool {
    return llm.tool({
      id: 'openai_code_interpreter',
      config: {
        type: 'code_interpreter',
        container: container ?? null,
      },
    });
  }
}
