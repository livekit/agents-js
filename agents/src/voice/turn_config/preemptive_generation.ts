// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Configuration for preemptive generation.
 */
export interface PreemptiveGenerationOptions {
  /**
   * Whether preemptive generation is enabled.
   * @defaultValue true
   */
  enabled: boolean;
  /**
   * Whether to also run TTS preemptively before the turn is confirmed.
   * When `false` (default), only LLM runs preemptively; TTS starts once the
   * turn is confirmed and the speech is scheduled.
   * @defaultValue false
   */
  preemptiveTts: boolean;
  /**
   * Maximum user speech duration (ms) for which preemptive generation
   * is attempted. Beyond this threshold, preemptive generation is skipped
   * since long utterances are more likely to change and users may expect
   * slower responses.
   * @defaultValue 10000
   */
  maxSpeechDuration: number;
  /**
   * Maximum number of preemptive generation attempts per user turn.
   * The counter resets when the turn completes.
   * @defaultValue 3
   */
  maxRetries: number;
}

export const defaultPreemptiveGenerationOptions = {
  enabled: true,
  preemptiveTts: false,
  maxSpeechDuration: 10_000,
  maxRetries: 3,
} as const satisfies PreemptiveGenerationOptions;
