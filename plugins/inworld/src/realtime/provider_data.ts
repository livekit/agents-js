// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

// Ref: python livekit-plugins/livekit-plugins-inworld/livekit/plugins/inworld/realtime/provider_data.py
//
// NOTE ON CASING: the Inworld Realtime wire format mixes snake_case and camelCase. Most of the
// `providerData` tree is snake_case, but `text_generation_config` and its nested `reasoning` object
// are camelCase. This is intentional and must be preserved exactly — these objects are serialized
// verbatim into the `session.update` event.

/** Speech-to-text configuration nested under {@link ProviderData.stt}. */
export interface STTProviderData {
  /** BCP-47 language tag hint for recognition, e.g. `'en-US'`. */
  language_code?: string;
  /** Custom vocabulary / phrase hints to bias recognition. */
  phrase_hints?: string[];
  /** Enable automatic punctuation in transcripts. */
  enable_automatic_punctuation?: boolean;
}

/** Text-to-speech configuration nested under {@link ProviderData.tts}. */
export interface TTSProviderData {
  /** Controls output variation. Only supported on `inworld-tts-2`. */
  delivery_mode?: 'DELIVERY_MODE_UNSPECIFIED' | 'STABLE' | 'BALANCED' | 'CREATIVE';
  /** Granularity of returned audio timestamps. */
  timestamp_type?: 'TIMESTAMP_TYPE_UNSPECIFIED' | 'WORD' | 'CHARACTER';
  /** Whether timestamps are delivered inline with audio or out of band. */
  timestamp_transport_strategy?: 'TIMESTAMP_TRANSPORT_STRATEGY_UNSPECIFIED' | 'SYNC' | 'ASYNC';
  /** Sampling temperature for the TTS model. */
  temperature?: number;
  /** Playback rate multiplier. `1.0` is normal speed. */
  speaking_rate?: number;
  /** BCP-47 language tag the voice should speak in. */
  language_code?: string;
}

/** Long-term memory configuration nested under {@link ProviderData.memory}. */
export interface MemoryProviderData {
  /** Enable cross-session memory retrieval and writes. */
  enabled?: boolean;
  /** Opaque identifier scoping stored memories to a single end user. */
  user_id?: string;
  /** Maximum number of memories to retrieve per turn. */
  max_memories?: number;
}

/** Backchannel ("mhm", "I see") configuration nested under {@link ProviderData.backchannel}. */
export interface BackchannelProviderData {
  /** Enable generated backchannel utterances while the user is speaking. */
  enabled?: boolean;
  /** Relative frequency of backchannels, `0.0` to `1.0`. */
  frequency?: number;
}

/** Turn-taking latency configuration nested under {@link ProviderData.responsiveness}. */
export interface ResponsivenessProviderData {
  /** How eagerly the model starts responding, `0.0` (patient) to `1.0` (eager). */
  level?: number;
  /** Silence required before the model treats the user turn as finished, in milliseconds. */
  silence_threshold_ms?: number;
}

/** Prompt caching configuration nested under {@link ProviderData.caching}. */
export interface CachingProviderData {
  /** Enable server-side prompt caching. */
  enabled?: boolean;
  /** Cache entry lifetime, in seconds. */
  ttl_seconds?: number;
}

/**
 * Reasoning configuration nested under {@link TextGenerationConfig.reasoning}.
 *
 * Uses camelCase keys, unlike the rest of {@link ProviderData}.
 */
export interface ReasoningConfig {
  /** Enable reasoning for models that support it. */
  enabled?: boolean;
  /** Upper bound on tokens spent reasoning before producing the answer. */
  maxTokens?: number;
}

/**
 * LLM sampling configuration nested under {@link ProviderData.text_generation_config}.
 *
 * Uses camelCase keys, unlike the rest of {@link ProviderData}.
 */
export interface TextGenerationConfig {
  /** Maximum number of tokens to generate per response. */
  maxNewTokens?: number;
  /** Sampling temperature. */
  temperature?: number;
  /** Nucleus sampling probability mass. */
  topP?: number;
  /** Penalty applied to tokens by prior frequency. */
  frequencyPenalty?: number;
  /** Penalty applied to tokens that already appeared. */
  presencePenalty?: number;
  /** Sequences that terminate generation when produced. */
  stopSequences?: string[];
  /** Per-token additive logit adjustments, keyed by token. */
  logitBias?: Record<string, number>;
  /** Reasoning configuration for models that support it. */
  reasoning?: ReasoningConfig;
}

/**
 * Inworld-specific session configuration, sent as `session.providerData` in the initial
 * `session.update` event.
 *
 * All fields are optional. Unknown keys are permitted so newly released server-side options can be
 * passed through without a plugin upgrade.
 */
export interface ProviderData {
  /**
   * Whether the server automatically generates a reply after a tool result is submitted.
   *
   * Defaults to `false` in this plugin, which hands turn continuation to the LiveKit agent instead
   * of the Inworld server. Set to `true` to let Inworld drive the follow-up response.
   */
  auto_tool_response?: boolean;
  /** Speech-to-text options. */
  stt?: STTProviderData;
  /** Text-to-speech options. */
  tts?: TTSProviderData;
  /** Long-term memory options. */
  memory?: MemoryProviderData;
  /** Backchannel options. */
  backchannel?: BackchannelProviderData;
  /** Turn-taking latency options. */
  responsiveness?: ResponsivenessProviderData;
  /** Prompt caching options. */
  caching?: CachingProviderData;
  /** LLM sampling options. Note: camelCase keys. */
  text_generation_config?: TextGenerationConfig;
  /** Opaque end-user identifier, used for memory scoping and analytics. */
  user_id?: string;
  /** Arbitrary string metadata echoed back on server events. */
  metadata?: Record<string, string>;
  /** Escape hatch for server-side options not yet modeled here. */
  [key: string]: unknown;
}
