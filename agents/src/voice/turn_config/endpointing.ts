// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
/**
 * Configuration for endpointing, which determines when the user's turn is complete.
 */
export interface EndpointingConfig {
  /**
   * Minimum time in milliseconds since the last detected speech before the agent declares the user's
   * turn complete. In VAD mode this effectively behaves like `max(VAD silence, minDelay)`;
   * in STT mode it is applied after the STT end-of-speech signal, so it can be additive with
   * the STT provider's endpointing delay.
   * @defaultValue 500
   */
  minDelay: number;
  /**
   * Maximum time in milliseconds the agent will wait before terminating the turn.
   * @defaultValue 3000
   */
  maxDelay: number;
}

export const defaultEndpointingConfig = {
  minDelay: 500,
  maxDelay: 3000,
} as const satisfies EndpointingConfig;
