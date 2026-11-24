// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
/**
 * Per-session director-notes overrides forwarded to Anam.
 *
 * Mirrors the `directorNotes` field of the Anam persona config. Every field is
 * optional; unset fields are omitted from the request so Anam falls back to the
 * avatar model / cue defaults. See https://anam.ai/docs/personas/director-notes
 * for the available style presets.
 *
 * @public
 */
export type DirectorNotes = {
  /**
   * Normalized expressivity in [0, 1] controlling how strongly the avatar
   * responds to `presetStyle`/`customStylePrompt` and any inline cues: 1
   * responds more strongly, 0 less strongly. Unset falls back to 0.5.
   * Out-of-range values are rejected by Anam with an HTTP 400.
   */
  expressivity?: number;
  /**
   * A built-in expressive style (e.g. `"happy"`, `"warm"`, `"playful"`).
   * Mutually exclusive with `customStylePrompt`; Anam rejects the pair with an
   * HTTP 400.
   */
  presetStyle?: string;
  /** A free-form expressive style prompt. Mutually exclusive with `presetStyle`. */
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
  /**
   * Optional director-notes overrides (prod flow). Not supported together with
   * `personaId`: a saved persona uses its own stored director notes.
   */
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
