// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type * as types from '@google/genai';
import { llm } from '@livekit/agents';

export type LLMTools = Omit<types.Tool, 'functionDeclarations'>;

export abstract class GeminiTool extends llm.ProviderTool {
  abstract toToolConfig(): types.Tool;
}

export class GoogleSearch extends GeminiTool {
  constructor(public readonly options: types.GoogleSearch = {}) {
    super({ id: 'gemini_google_search' });
  }

  toToolConfig(): types.Tool {
    return { googleSearch: this.options };
  }
}

export class GoogleMaps extends GeminiTool {
  constructor(public readonly options: types.GoogleMaps = {}) {
    super({ id: 'gemini_google_maps' });
  }

  toToolConfig(): types.Tool {
    return { googleMaps: this.options };
  }
}

export class URLContext extends GeminiTool {
  constructor() {
    super({ id: 'gemini_url_context' });
  }

  toToolConfig(): types.Tool {
    return { urlContext: {} };
  }
}

export interface FileSearchOptions extends types.FileSearch {
  fileSearchStoreNames: string[];
}

export class FileSearch extends GeminiTool {
  constructor(public readonly options: FileSearchOptions) {
    super({ id: 'gemini_file_search' });
  }

  toToolConfig(): types.Tool {
    return { fileSearch: this.options };
  }
}

export class ToolCodeExecution extends GeminiTool {
  constructor() {
    super({ id: 'gemini_code_execution' });
  }

  toToolConfig(): types.Tool {
    return { codeExecution: {} };
  }
}

export interface VertexRAGRetrievalOptions {
  ragResources: string[];
  similarityTopK?: number;
  vectorDistanceThreshold?: number;
}

export class VertexRAGRetrieval extends GeminiTool {
  readonly ragResources: string[];
  readonly similarityTopK: number;
  readonly vectorDistanceThreshold?: number;

  constructor({
    ragResources,
    similarityTopK = 3,
    vectorDistanceThreshold,
  }: VertexRAGRetrievalOptions) {
    super({ id: 'gemini_vertex_rag_retrieval' });
    this.ragResources = ragResources;
    this.similarityTopK = similarityTopK;
    this.vectorDistanceThreshold = vectorDistanceThreshold;
  }

  toToolConfig(): types.Tool {
    return {
      retrieval: {
        vertexRagStore: {
          ragResources: this.ragResources.map((ragCorpus) => ({ ragCorpus })),
          similarityTopK: this.similarityTopK,
          vectorDistanceThreshold: this.vectorDistanceThreshold,
        },
      },
    };
  }
}
