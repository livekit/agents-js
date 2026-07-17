// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/** @public */
export type TTSModels = 's1' | 's2-pro' | 's2.1-pro';

/** @public */
export type LatencyMode = 'normal' | 'balanced' | 'low';

/**
 * MP3 bitrate in kbps.
 * @public
 */
export type MP3Bitrate = 64 | 128 | 192;

/**
 * Opus bitrate in bps. `-1000` selects Fish Audio's automatic bitrate.
 * @public
 */
export type OpusBitrate = -1000 | 24000 | 32000 | 48000 | 64000;
