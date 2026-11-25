// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
/** @public */
export type PersonaConfig = {
  /** Optional display name (prod flow) */
  name?: string;
  /** Optional avatar asset id (prod flow) */
  avatarId?: string;
  /** Optional avatar model version, e.g. "cara-3" or "cara-4-latest" (prod flow) */
  avatarModel?: string;
  /** Optional persona id (dev flow) */
  personaId?: string;
};

/** @public */
export type SessionOptions = {
  /** Output video frame width in pixels. Provide together with videoHeight. */
  videoWidth?: number;
  /** Output video frame height in pixels. Provide together with videoWidth. */
  videoHeight?: number;
  /**
   * Engine region that serves the session's audio and video. Omit to let Anam
   * route the session. Region selection must be enabled for the Anam
   * organization; otherwise Anam rejects the request with an HTTP 403. See
   * https://anam.ai/docs/personas/session/regions
   */
  region?: 'eu' | 'us';
  /**
   * `'preferred'` (Anam's default) lets Anam fail over to another region;
   * `'strict'` never does, and the session fails when `region` is unavailable.
   * `'strict'` requires `region`.
   */
  regionPolicy?: 'preferred' | 'strict';
};

/** @public */
export type APIConnectOptions = {
  maxRetry?: number;
  retryInterval?: number; // seconds
  timeout?: number; // seconds
};

/** @public */
export class AnamException extends Error {}
