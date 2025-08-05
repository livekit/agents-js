import type {
  GoogleMaps,
  GoogleSearch,
  GoogleSearchRetrieval,
  ToolCodeExecution,
  UrlContext,
} from '@google/genai';

export type LLMTool =
  | GoogleMaps
  | GoogleSearch
  | GoogleSearchRetrieval
  | ToolCodeExecution
  | UrlContext;
