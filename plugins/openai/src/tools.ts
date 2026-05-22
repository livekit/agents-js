// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { llm } from '@livekit/agents';

export abstract class OpenAITool extends llm.ProviderTool {
  abstract toToolConfig(): Record<string, unknown>;
}

export type WebSearchContextSize = 'low' | 'medium' | 'high';

export interface WebSearchOptions {
  filters?: Record<string, unknown>;
  searchContextSize?: WebSearchContextSize | null;
  userLocation?: Record<string, unknown>;
}

export class WebSearch extends OpenAITool {
  readonly filters: Record<string, unknown> | undefined;
  readonly searchContextSize: WebSearchContextSize | null;
  readonly userLocation: Record<string, unknown> | undefined;

  constructor({ filters, searchContextSize = 'medium', userLocation }: WebSearchOptions = {}) {
    super({ id: 'openai_web_search' });
    this.filters = filters;
    this.searchContextSize = searchContextSize;
    this.userLocation = userLocation;
  }

  toToolConfig(): Record<string, unknown> {
    const result: Record<string, unknown> = {
      type: 'web_search',
      search_context_size: this.searchContextSize,
    };
    if (this.userLocation !== undefined) {
      result.user_location = this.userLocation;
    }
    if (this.filters !== undefined) {
      result.filters = this.filters;
    }
    return result;
  }
}

export interface FileSearchOptions {
  vectorStoreIds?: string[];
  filters?: Record<string, unknown>;
  maxNumResults?: number;
  rankingOptions?: Record<string, unknown>;
}

export class FileSearch extends OpenAITool {
  readonly vectorStoreIds: string[];
  readonly filters: Record<string, unknown> | undefined;
  readonly maxNumResults: number | undefined;
  readonly rankingOptions: Record<string, unknown> | undefined;

  constructor({
    vectorStoreIds = [],
    filters,
    maxNumResults,
    rankingOptions,
  }: FileSearchOptions = {}) {
    super({ id: 'openai_file_search' });
    this.vectorStoreIds = [...vectorStoreIds];
    this.filters = filters;
    this.maxNumResults = maxNumResults;
    this.rankingOptions = rankingOptions;
  }

  toToolConfig(): Record<string, unknown> {
    const result: Record<string, unknown> = {
      type: 'file_search',
      vector_store_ids: this.vectorStoreIds,
    };
    if (this.filters !== undefined) {
      result.filters = this.filters;
    }
    if (this.maxNumResults !== undefined) {
      result.max_num_results = this.maxNumResults;
    }
    if (this.rankingOptions !== undefined) {
      result.ranking_options = this.rankingOptions;
    }
    return result;
  }
}

export interface CodeInterpreterOptions {
  container?: string | Record<string, unknown> | null;
}

export class CodeInterpreter extends OpenAITool {
  readonly container: string | Record<string, unknown> | null;

  constructor({ container = null }: CodeInterpreterOptions = {}) {
    super({ id: 'openai_code_interpreter' });
    this.container = container;
  }

  toToolConfig(): Record<string, unknown> {
    return { type: 'code_interpreter', container: this.container };
  }
}
