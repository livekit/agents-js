// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/** @public */
export const DEFAULT_SAMPLE_RATE = 24000;

/**
 * Configuration for the audio sent to the D-ID avatar.
 *
 * @public
 */
export interface AudioConfig {
  /** Sample rate in Hz. Supported values: 16000, 24000, 48000. Defaults to 24000. */
  sampleRate?: number;
}
