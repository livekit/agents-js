// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { llm } from '@livekit/agents';
import type OpenAI from 'openai';

/** A provider tool for the OpenAI Responses API. */
export abstract class OpenAITool extends llm.ProviderTool {
  /** Convert the tool to an OpenAI Responses API tool configuration. */
  abstract toToolConfig(): Record<string, unknown>;
}

/**
 * High level guidance for the amount of context window space to use for the search.
 * One of `low`, `medium`, or `high`. `medium` is the default.
 */
export type WebSearchContextSize = 'low' | 'medium' | 'high';

/** Options for the web search tool. */
export interface WebSearchOptions {
  /**
   * Filters for the search. If `allowed_domains` is not provided, all domains are allowed.
   */
  filters?: OpenAI.Responses.WebSearchTool['filters'];

  /**
   * High level guidance for the amount of context window space to use for the search.
   * One of `low`, `medium`, or `high`. `medium` is the default.
   */
  searchContextSize?: WebSearchContextSize | null;

  /** The approximate location of the user. */
  userLocation?: OpenAI.Responses.WebSearchTool['user_location'];
}

/**
 * Search the Internet for sources related to the prompt.
 *
 * @see https://platform.openai.com/docs/guides/tools-web-search
 */
export class WebSearch extends OpenAITool {
  /** Filters for the search. */
  readonly filters: OpenAI.Responses.WebSearchTool['filters'] | undefined;

  /** High level guidance for the amount of context window space to use for the search. */
  readonly searchContextSize: WebSearchContextSize | null;

  /** The approximate location of the user. */
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

/** Options for the file search tool. */
export interface FileSearchOptions {
  /** The IDs of the vector stores to search. */
  vectorStoreIds?: string[];

  /** A filter to apply. */
  filters?: OpenAI.Responses.FileSearchTool['filters'];

  /** The maximum number of results to return. This number should be between 1 and 50 inclusive. */
  maxNumResults?: number;

  /** Ranking options for search. */
  rankingOptions?: OpenAI.Responses.FileSearchTool.RankingOptions;
}

/**
 * A tool that searches for relevant content from uploaded files.
 *
 * @see https://platform.openai.com/docs/guides/tools-file-search
 */
export class FileSearch extends OpenAITool {
  /** The IDs of the vector stores to search. */
  readonly vectorStoreIds: string[];

  /** A filter to apply. */
  readonly filters: OpenAI.Responses.FileSearchTool['filters'] | undefined;

  /** The maximum number of results to return. */
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

/** Options for the code interpreter tool. */
export interface CodeInterpreterOptions {
  /**
   * The code interpreter container. Can be a container ID or an object that specifies uploaded file IDs
   * to make available to the code.
   */
  container?: OpenAI.Responses.Tool.CodeInterpreter['container'] | null;
}

/**
 * A tool that runs Python code to help generate a response to a prompt.
 *
 * @see https://platform.openai.com/docs/guides/tools-code-interpreter
 */
export class CodeInterpreter extends OpenAITool {
  /** The code interpreter container. */
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
