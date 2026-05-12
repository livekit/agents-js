// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { llm } from '@livekit/agents';

export class WebSearch {
  static create(): llm.ProviderDefinedTool {
    return llm.tool({
      id: 'xai_web_search',
      config: { type: 'web_search' },
    });
  }
}

export class XSearch {
  static create({ allowedXHandles }: { allowedXHandles?: string[] } = {}): llm.ProviderDefinedTool {
    return llm.tool({
      id: 'xai_x_search',
      config: {
        type: 'x_search',
        ...(allowedXHandles !== undefined ? { allowed_x_handles: allowedXHandles } : {}),
      },
    });
  }
}

export class FileSearch {
  static create({
    vectorStoreIds = [],
    maxNumResults,
  }: {
    vectorStoreIds?: string[];
    maxNumResults?: number;
  } = {}): llm.ProviderDefinedTool {
    return llm.tool({
      id: 'xai_file_search',
      config: {
        type: 'file_search',
        vector_store_ids: vectorStoreIds,
        ...(maxNumResults !== undefined ? { max_num_results: maxNumResults } : {}),
      },
    });
  }
}
