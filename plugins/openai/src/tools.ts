// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { llm } from '@livekit/agents';
import type OpenAI from 'openai';

/** Base class for OpenAI Responses API provider tools. */
export abstract class OpenAITool extends llm.ProviderTool {
  /** Convert this provider tool to the OpenAI Responses API tool configuration. */
  abstract toToolConfig(): Record<string, unknown>;
}

/**
 * High-level guidance for the amount of context window space to use for web search.
 * OpenAI defaults this to `medium`.
 */
export type WebSearchContextSize = 'low' | 'medium' | 'high';

/** Options for the OpenAI web search tool. */
export interface WebSearchOptions {
  /**
   * Filters for the search, such as allowed domains. If not provided, all domains are allowed.
   */
  filters?: OpenAI.Responses.WebSearchTool['filters'];

  /**
   * Amount of context window space to use for the search. Defaults to `medium`.
   */
  searchContextSize?: WebSearchContextSize | null;

  /** Approximate location of the user, such as city, region, country, or timezone. */
  userLocation?: OpenAI.Responses.WebSearchTool['user_location'];
}

/**
 * Search the Internet for sources related to the prompt.
 *
 * @see https://platform.openai.com/docs/guides/tools-web-search
 */
export class WebSearch extends OpenAITool {
  /** Filters for the search, such as allowed domains. */
  readonly filters: OpenAI.Responses.WebSearchTool['filters'] | undefined;

  /** Amount of context window space to use for the search. */
  readonly searchContextSize: WebSearchContextSize | null;

  /** Approximate location of the user. */
  readonly userLocation: OpenAI.Responses.WebSearchTool['user_location'] | undefined;

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

/** Options for the OpenAI file search tool. */
export interface FileSearchOptions {
  /** IDs of the vector stores to search. */
  vectorStoreIds?: string[];

  /** Filter to apply to file search results. */
  filters?: OpenAI.Responses.FileSearchTool['filters'];

  /** Maximum number of results to return. This should be between 1 and 50 inclusive. */
  maxNumResults?: number;

  /** Ranking options for search, including ranker and score threshold. */
  rankingOptions?: OpenAI.Responses.FileSearchTool.RankingOptions;
}

/**
 * Search for relevant content from uploaded files.
 *
 * @see https://platform.openai.com/docs/guides/tools-file-search
 */
export class FileSearch extends OpenAITool {
  /** IDs of the vector stores to search. */
  readonly vectorStoreIds: string[];

  /** Filter to apply to file search results. */
  readonly filters: OpenAI.Responses.FileSearchTool['filters'] | undefined;

  /** Maximum number of results to return. */
  readonly maxNumResults: number | undefined;

  /** Ranking options for search. */
  readonly rankingOptions: OpenAI.Responses.FileSearchTool.RankingOptions | undefined;

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

/** Options for the OpenAI code interpreter tool. */
export interface CodeInterpreterOptions {
  /**
   * Code interpreter container. Can be a container ID or an object that specifies uploaded file IDs
   * to make available to the code.
   */
  container?: OpenAI.Responses.Tool.CodeInterpreter['container'] | null;
}

/**
 * Run Python code to help generate a response to a prompt.
 *
 * @see https://platform.openai.com/docs/guides/tools-code-interpreter
 */
export class CodeInterpreter extends OpenAITool {
  /** Code interpreter container ID or configuration. */
  readonly container: OpenAI.Responses.Tool.CodeInterpreter['container'] | null;

  constructor({ container = null }: CodeInterpreterOptions = {}) {
    super({ id: 'openai_code_interpreter' });
    this.container = container;
  }

  toToolConfig(): Record<string, unknown> {
    const result: Record<string, unknown> = { type: 'code_interpreter' };
    if (this.container !== null) {
      result.container = this.container;
    }
    return result;
  }
}
