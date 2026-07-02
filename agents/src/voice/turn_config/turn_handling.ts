// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { TurnDetectionMode } from '../agent_session.js';
import { type EndpointingOptions, defaultEndpointingOptions } from './endpointing.js';
import { type InterruptionOptions, defaultInterruptionOptions } from './interruption.js';
import {
  type PreemptiveGenerationOptions,
  defaultPreemptiveGenerationOptions,
} from './preemptive_generation.js';
import { type UserTurnLimitOptions, defaultUserTurnLimitOptions } from './user_turn_limit.js';

/**
 * Configuration for the turn handling system. Used to configure the turn taking behavior of the
 * session.
 *
 * @example
 * ```ts
 * session.start({
 *   agent,
 *   room,
 *   turnHandling: {
 *     endpointing: { minDelay: 300 },
 *     interruption: { enabled: false },
 *     preemptiveGeneration: { preemptiveTts: true },
 *   },
 * });
 * ```
 */
export interface TurnHandlingOptions {
  /**
   * Strategy for deciding when the user has finished speaking.
   *
   * - `"stt"` – rely on speech-to-text end-of-utterance cues
   * - `"vad"` – rely on Voice Activity Detection start/stop cues
   * - `"realtime_llm"` – use server-side detection from a realtime LLM
   * - `"manual"` – caller controls turn boundaries explicitly
   *
   * - `undefined` (not set) – the session auto-provisions a default
   *   `inference.TurnDetector`, then chooses the best available mode in
   *   priority order `realtime_llm → vad → stt → manual`, falling back if the
   *   necessary model is missing.
   * - `null` – explicitly opt out of turn detection (no default detector built).
   */
  turnDetection: TurnDetectionMode | null | undefined;
  /**
   * Configuration for endpointing.
   */
  endpointing: Partial<EndpointingOptions>;
  /**
   * Configuration for interruption handling.
   */
  interruption: Partial<InterruptionOptions>;
  /**
   * Preemptive generation configuration. Use `{ enabled: false }` to disable.
   */
  preemptiveGeneration: Partial<PreemptiveGenerationOptions>;
  /**
   * User turn limit configuration. Use `{ maxWords: 50 }` to enable.
   */
  userTurnLimit?: Partial<UserTurnLimitOptions>;
}

export interface InternalTurnHandlingOptions extends TurnHandlingOptions {
  endpointing: EndpointingOptions;
  /** Sparse endpointing keys the user provided explicitly. */
  endpointingOverrides: Partial<EndpointingOptions>;
  interruption: InterruptionOptions;
  preemptiveGeneration: PreemptiveGenerationOptions;
  userTurnLimit: UserTurnLimitOptions;
}

export const defaultTurnHandlingOptions: InternalTurnHandlingOptions = {
  turnDetection: undefined,
  interruption: defaultInterruptionOptions,
  endpointing: defaultEndpointingOptions,
  endpointingOverrides: {},
  preemptiveGeneration: defaultPreemptiveGenerationOptions,
  userTurnLimit: defaultUserTurnLimitOptions,
};
