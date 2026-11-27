// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type Anthropic from '@anthropic-ai/sdk';
import { llm } from '@livekit/agents';

/**
 * Options for Anthropic's server-side web search tool.
 * @public
 */
export interface WebSearchOptions {
  /** Maximum searches per API request. */
  maxUses?: number;
  /** Restrict results to these domains. Cannot be combined with `blockedDomains`. */
  allowedDomains?: string[];
  /** Exclude these domains. Cannot be combined with `allowedDomains`. */
  blockedDomains?: string[];
  /** Approximate user location for geographically relevant results. */
  userLocation?: Anthropic.WebSearchTool20250305['user_location'];
}

/**
 * Search the web using Anthropic's hosted `web_search_20250305` tool.
 * Add this tool to the agent's tools alongside any function tools.
 * @public
 * @see https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool
 */
export class WebSearch extends llm.ProviderTool {
  constructor(private readonly options: WebSearchOptions = {}) {
    super({ id: 'anthropic_web_search' });
  }

  /** Convert to Anthropic's native server tool configuration. */
  toToolConfig(): Anthropic.WebSearchTool20250305 {
    const { maxUses, allowedDomains, blockedDomains, userLocation } = this.options;
    return {
      type: 'web_search_20250305',
      name: 'web_search',
      ...(maxUses !== undefined ? { max_uses: maxUses } : {}),
      ...(allowedDomains !== undefined ? { allowed_domains: allowedDomains } : {}),
      ...(blockedDomains !== undefined ? { blocked_domains: blockedDomains } : {}),
      ...(userLocation !== undefined ? { user_location: userLocation } : {}),
    };
  }
}
