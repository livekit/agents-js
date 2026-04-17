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
   * If not set, the session chooses the best available mode in priority order
   * `realtime_llm → vad → stt → manual`; it automatically falls back if the necessary model
   * is missing.
   */
  turnDetection: TurnDetectionMode | undefined;
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
}

export interface InternalTurnHandlingOptions extends TurnHandlingOptions {
  endpointing: EndpointingOptions;
  interruption: InterruptionOptions;
  preemptiveGeneration: PreemptiveGenerationOptions;
}

export const defaultTurnHandlingOptions: InternalTurnHandlingOptions = {
  turnDetection: undefined,
  interruption: defaultInterruptionOptions,
  endpointing: defaultEndpointingOptions,
  preemptiveGeneration: defaultPreemptiveGenerationOptions,
};
