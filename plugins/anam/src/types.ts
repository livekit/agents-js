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
   * Anam's default is not to render an AI avatar disclosure watermark. Set to
   * `true` to have Anam disclose that the video contains an AI avatar via a
   * watermark.
   */
  showAIAvatarDisclosure?: boolean;
};

/** @public */
export type APIConnectOptions = {
  maxRetry?: number;
  retryInterval?: number; // seconds
  timeout?: number; // seconds
};

/** @public */
export class AnamException extends Error {}
