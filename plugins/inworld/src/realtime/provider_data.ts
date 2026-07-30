// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

// Ref: python livekit-plugins/livekit-plugins-inworld/livekit/plugins/inworld/realtime/provider_data.py
//
// Wire format mixes casing: most of `providerData` is snake_case, but `text_generation_config`
// and its nested `reasoning` object are camelCase. Serialized verbatim into `session.update`.

/** Speech recognition hints forwarded to Inworld as `providerData.stt`. */
export interface STTProviderData {
  language_code?: string;
  phrase_hints?: string[];
  enable_automatic_punctuation?: boolean;
}

/** Synthesis options forwarded to Inworld as `providerData.tts`. */
export interface TTSProviderData {
  delivery_mode?: 'DELIVERY_MODE_UNSPECIFIED' | 'STABLE' | 'BALANCED' | 'CREATIVE';
  timestamp_type?: 'TIMESTAMP_TYPE_UNSPECIFIED' | 'WORD' | 'CHARACTER';
  timestamp_transport_strategy?: 'TIMESTAMP_TRANSPORT_STRATEGY_UNSPECIFIED' | 'SYNC' | 'ASYNC';
  temperature?: number;
  speaking_rate?: number;
  language_code?: string;
}

/** Long-term memory options forwarded to Inworld as `providerData.memory`. */
export interface MemoryProviderData {
  enabled?: boolean;
  user_id?: string;
  max_memories?: number;
}

/** Backchannel options forwarded to Inworld as `providerData.backchannel`. */
export interface BackchannelProviderData {
  enabled?: boolean;
  frequency?: number;
}

/** Turn-taking latency options forwarded to Inworld as `providerData.responsiveness`. */
export interface ResponsivenessProviderData {
  level?: number;
  silence_threshold_ms?: number;
}

/** Explicit prompt-caching options forwarded to Inworld as `providerData.caching`. */
export interface CachingProviderData {
  enabled?: boolean;
  /** Cache lifetime, e.g. `'5m'` or `'1h'`. Empty string uses the provider default. */
  ttl?: string;
  /** Attach a breakpoint to system instructions. Defaults to `true` when enabled. */
  cache_instructions?: boolean;
  /** Attach a breakpoint to tool definitions. Defaults to `true` when enabled. */
  cache_tools?: boolean;
}

/**
 * Reasoning options nested under {@link TextGenerationConfig.reasoning}.
 * Uses camelCase (unlike the rest of {@link ProviderData}).
 */
export interface ReasoningConfig {
  enabled?: boolean;
  maxTokens?: number;
}

/**
 * LLM sampling options forwarded to Inworld as `providerData.text_generation_config`.
 * Uses camelCase (unlike the rest of {@link ProviderData}).
 */
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
   * Whether Inworld should auto-reply after a tool result.
   *
   * Always forced to `false` by `RealtimeModel`: the OpenAI base hard-codes
   * `capabilities.autoToolReplyGeneration` to `false`, so enabling this would make both the
   * server and the LiveKit agent speak after every tool call.
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
