// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
/**
 * Configuration for interruption handling.
 */
export interface InterruptionOptions {
  /**
   * Whether interruptions are enabled.
   * @defaultValue true
   */
  enabled: boolean;
  /**
   * Interruption handling strategy. `"adaptive"` for ML-based detection, `"vad"` for simple
   * voice-activity detection. `undefined` means auto-detect.
   * @defaultValue undefined
   */
  mode: 'adaptive' | 'vad' | undefined;
  /**
   * When `true`, buffered audio is dropped while the agent is speaking and cannot be interrupted.
   * @defaultValue true
   */
  discardAudioIfUninterruptible: boolean;
  /**
   * Minimum speech length in milliseconds to register as an interruption.
   * @defaultValue 500
   */
  minDuration: number;
  /**
   * Minimum number of words to consider an interruption, only used if STT is enabled.
   * @defaultValue 0
   */
  minWords: number;
  /**
   * If set, emit an `agentFalseInterruption` event after this amount of time if the user is
   * silent and no user transcript is detected after the interruption. Set to `undefined` to
   * disable. The value is in milliseconds.
   * @defaultValue 2000
   */
  falseInterruptionTimeout: number;
  /**
   * Whether to resume the false interruption after the `falseInterruptionTimeout`.
   * @defaultValue true
   */
  resumeFalseInterruption: boolean;
  /**
   * Milliseconds near the start/end of each agent turn during which overlapping speech classified
   * as a backchannel by the adaptive detector is suppressed. Events flagged as interruptions still
   * pass through.
   *
   * Pass a single number to use the same value for both the start and end boundaries, or a
   * `[start, end]` tuple to configure them separately.
   *
   * `null` disables.
   *
   * @defaultValue [1000, 1000]
   */
  backchannelBoundary: number | [number, number] | null;
}

export const defaultInterruptionOptions = {
  enabled: true,
  mode: undefined,
  discardAudioIfUninterruptible: true,
  minDuration: 500,
  minWords: 0,
  falseInterruptionTimeout: 2000,
  resumeFalseInterruption: true,
  backchannelBoundary: [1000, 1000],
} as const satisfies InterruptionOptions;
