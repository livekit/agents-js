// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

// Ref: python livekit-plugins/livekit-plugins-inworld/livekit/plugins/inworld/realtime/provider_data.py
//
// Wire format mixes casing: most of `providerData` is snake_case, but `text_generation_config`
// and its nested `reasoning` object are camelCase. Serialized verbatim into `session.update`.

export interface STTProviderData {
  language_code?: string;
  phrase_hints?: string[];
  enable_automatic_punctuation?: boolean;
}

export interface TTSProviderData {
  delivery_mode?: 'DELIVERY_MODE_UNSPECIFIED' | 'STABLE' | 'BALANCED' | 'CREATIVE';
  timestamp_type?: 'TIMESTAMP_TYPE_UNSPECIFIED' | 'WORD' | 'CHARACTER';
  timestamp_transport_strategy?: 'TIMESTAMP_TRANSPORT_STRATEGY_UNSPECIFIED' | 'SYNC' | 'ASYNC';
  temperature?: number;
  speaking_rate?: number;
  language_code?: string;
}

export interface MemoryProviderData {
  enabled?: boolean;
  user_id?: string;
  max_memories?: number;
}

export interface BackchannelProviderData {
  enabled?: boolean;
  frequency?: number;
}

export interface ResponsivenessProviderData {
  level?: number;
  silence_threshold_ms?: number;
}

export interface CachingProviderData {
  enabled?: boolean;
  /** Cache lifetime, e.g. `'5m'` or `'1h'`. Empty string uses the provider default. */
  ttl?: string;
  /** Attach a breakpoint to system instructions. Defaults to `true` when enabled. */
  cache_instructions?: boolean;
  /** Attach a breakpoint to tool definitions. Defaults to `true` when enabled. */
  cache_tools?: boolean;
}

/** camelCase (unlike the rest of {@link ProviderData}). */
export interface ReasoningConfig {
  enabled?: boolean;
  maxTokens?: number;
}

/** camelCase (unlike the rest of {@link ProviderData}). */
export interface TextGenerationConfig {
  maxNewTokens?: number;
  temperature?: number;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  stopSequences?: string[];
  logitBias?: Record<string, number>;
  reasoning?: ReasoningConfig;
}

/**
 * Inworld-only fields sent as `session.providerData` on the initial `session.update`.
 * Unknown keys are allowed for forward compatibility.
 */
export interface ProviderData {
  /**
   * When `true`, Inworld auto-replies after a tool result. Defaults to `false` so the LiveKit
   * agent owns turn continuation (`maxToolSteps`).
   */
  auto_tool_response?: boolean;
  stt?: STTProviderData;
  tts?: TTSProviderData;
  memory?: MemoryProviderData;
  backchannel?: BackchannelProviderData;
  responsiveness?: ResponsivenessProviderData;
  caching?: CachingProviderData;
  text_generation_config?: TextGenerationConfig;
  user_id?: string;
  metadata?: Record<string, string>;
  [key: string]: unknown;
}
