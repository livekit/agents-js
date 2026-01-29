// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { TurnDetectionMode } from '../agent_session.js';
import { type EndpointingConfig, defaultEndpointingConfig } from './endpointing.js';
import { type InterruptionConfig, defaultInterruptionConfig } from './interruption.js';

/**
 * Configuration for the turn handling system. Used to configure the turn taking behavior of the
 * session.
 */
export interface TurnHandlingConfig {
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
  endpointing: EndpointingConfig;
  /**
   * Configuration for interruption handling.
   */
  interruption: InterruptionConfig;
  /**
   * If set, set the user state as "away" after this amount of time after user and agent are
   * silent. Set to `undefined` to disable.
   * @defaultValue 15.0
   */
  userAwayTimeout: number;
  /**
   * Whether to speculatively begin LLM and TTS requests before an end-of-turn is detected.
   * When `true`, the agent sends inference calls as soon as a user transcript is received rather
   * than waiting for a definitive turn boundary. This can reduce response latency by overlapping
   * model inference with user audio, but may incur extra compute if the user interrupts or
   * revises mid-utterance.
   * @defaultValue false
   */
  preemptiveGeneration: boolean;
}

export const defaultTurnHandlingConfig: TurnHandlingConfig = {
  turnDetection: undefined,
  interruption: defaultInterruptionConfig,
  endpointing: defaultEndpointingConfig,
  userAwayTimeout: 15,
  preemptiveGeneration: false,
};
