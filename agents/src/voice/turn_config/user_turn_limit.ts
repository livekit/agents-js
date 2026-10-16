// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Configuration for detecting when a user has been speaking too long without the agent
 * successfully responding.
 *
 * The framework tracks accumulated word count and wall-clock duration across consecutive user
 * turns. Counters only reset when the agent transitions to speaking state.
 *
 * Both thresholds default to `null` (disabled). Set at least one to enable the feature.
 */
export interface UserTurnLimitOptions {
  /**
   * Maximum accumulated word count before triggering. `null` disables word-based limiting.
   */
  maxWords: number | null;

  /**
   * Maximum wall-clock duration in milliseconds since the user first started speaking in the
   * current accumulation window. `null` disables duration-based limiting.
   */
  maxDuration: number | null;
}

export const defaultUserTurnLimitOptions: UserTurnLimitOptions = {
  maxWords: null,
  maxDuration: null,
};
