// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
/** @public */
export type DirectorNotes = {
  /** Normalized expressivity in [0, 1] controlling how strongly the avatar responds to style/cues. */
  expressivity?: number;
  /** Built-in expressive style, mutually exclusive with customStylePrompt. */
  presetStyle?: string;
  /** Free-form expressive style prompt, mutually exclusive with presetStyle. */
  customStylePrompt?: string;
};

/** @public */
export type PersonaConfig = {
  /** Optional display name (prod flow) */
  name?: string;
  /** Optional avatar asset id (prod flow) */
  avatarId?: string;
  /** Optional avatar model version, e.g. "cara-3" or "cara-4-latest" (prod flow) */
  avatarModel?: string;
  /** Optional per-session director-notes overrides (prod flow) */
  directorNotes?: DirectorNotes;
  /** Optional persona id (dev flow) */
  personaId?: string;
};

/** @public */
export type SessionOptions = {
  /** Output video frame width in pixels. Provide together with videoHeight. */
  videoWidth?: number;
  /** Output video frame height in pixels. Provide together with videoWidth. */
  videoHeight?: number;
};

/** @public */
export type APIConnectOptions = {
  maxRetry?: number;
  retryInterval?: number; // seconds
  timeout?: number; // seconds
};

/** @public */
export class AnamException extends Error {}
