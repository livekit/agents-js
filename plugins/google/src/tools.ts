// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
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
