// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { llm } from '@livekit/agents';

export abstract class XAITool extends llm.ProviderTool {
  abstract toToolConfig(): Record<string, unknown>;
}

/** Enable web search tool for real-time internet searches. */
export class WebSearch extends XAITool {
  constructor() {
    super({ id: 'xai_web_search' });
  }

  toToolConfig(): Record<string, unknown> {
    return { type: 'web_search' };
  }
}

export interface XSearchOptions {
  allowedXHandles?: string[];
}

/** Enable X search tool for searching posts. */
export class XSearch extends XAITool {
  readonly allowedXHandles: string[] | undefined;

  constructor({ allowedXHandles }: XSearchOptions = {}) {
    super({ id: 'xai_x_search' });
    this.allowedXHandles = allowedXHandles ? [...allowedXHandles] : undefined;
  }

  toToolConfig(): Record<string, unknown> {
    const result: Record<string, unknown> = { type: 'x_search' };
    if (this.allowedXHandles !== undefined) {
      result.allowed_x_handles = this.allowedXHandles;
    }
    return result;
  }
}

export interface FileSearchOptions {
  vectorStoreIds?: string[];
  maxNumResults?: number;
}

/** Enable file search tool for searching uploaded document collections. */
export class FileSearch extends XAITool {
  readonly vectorStoreIds: string[];
  readonly maxNumResults: number | undefined;

  constructor({ vectorStoreIds = [], maxNumResults }: FileSearchOptions = {}) {
    super({ id: 'xai_file_search' });
    this.vectorStoreIds = [...vectorStoreIds];
    this.maxNumResults = maxNumResults;
  }

  toToolConfig(): Record<string, unknown> {
    const result: Record<string, unknown> = {
      type: 'file_search',
      vector_store_ids: this.vectorStoreIds,
    };
    if (this.maxNumResults !== undefined) {
      result.max_num_results = this.maxNumResults;
    }
    return result;
  }
}
