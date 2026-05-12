// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { Tool } from '@google/genai';
import { llm } from '@livekit/agents';

export type LLMTools = Omit<Tool, 'functionDeclarations'>;

export class GoogleSearch {
  static create({
    excludeDomains,
    blockingConfidence,
    timeRangeFilter,
  }: {
    excludeDomains?: string[];
    blockingConfidence?: string;
    timeRangeFilter?: Record<string, unknown>;
  } = {}): llm.ProviderDefinedTool {
    return llm.tool({
      id: 'gemini_google_search',
      config: {
        googleSearch: {
          ...(excludeDomains !== undefined ? { excludeDomains } : {}),
          ...(blockingConfidence !== undefined ? { blockingConfidence } : {}),
          ...(timeRangeFilter !== undefined ? { timeRangeFilter } : {}),
        },
      },
    });
  }
}

export class GoogleMaps {
  static create({
    authConfig,
    enableWidget,
  }: {
    authConfig?: Record<string, unknown>;
    enableWidget?: boolean;
  } = {}): llm.ProviderDefinedTool {
    return llm.tool({
      id: 'gemini_google_maps',
      config: {
        googleMaps: {
          ...(authConfig !== undefined ? { authConfig } : {}),
          ...(enableWidget !== undefined ? { enableWidget } : {}),
        },
      },
    });
  }
}

export class URLContext {
  static create(): llm.ProviderDefinedTool {
    return llm.tool({
      id: 'gemini_url_context',
      config: { urlContext: {} },
    });
  }
}

export class FileSearch {
  static create({
    fileSearchStoreNames,
    topK,
    metadataFilter,
  }: {
    fileSearchStoreNames: string[];
    topK?: number;
    metadataFilter?: string;
  }): llm.ProviderDefinedTool {
    return llm.tool({
      id: 'gemini_file_search',
      config: {
        fileSearch: {
          fileSearchStoreNames,
          ...(topK !== undefined ? { topK } : {}),
          ...(metadataFilter !== undefined ? { metadataFilter } : {}),
        },
      },
    });
  }
}

export class ToolCodeExecution {
  static create(): llm.ProviderDefinedTool {
    return llm.tool({
      id: 'gemini_code_execution',
      config: { codeExecution: {} },
    });
  }
}

export class VertexRAGRetrieval {
  static create({
    ragResources,
    similarityTopK = 3,
    vectorDistanceThreshold,
  }: {
    ragResources: string[];
    similarityTopK?: number;
    vectorDistanceThreshold?: number;
  }): llm.ProviderDefinedTool {
    return llm.tool({
      id: 'gemini_vertex_rag_retrieval',
      config: {
        retrieval: {
          vertexRagStore: {
            ragResources: ragResources.map((ragCorpus) => ({ ragCorpus })),
            similarityTopK,
            ...(vectorDistanceThreshold !== undefined ? { vectorDistanceThreshold } : {}),
          },
        },
      },
    });
  }
}
