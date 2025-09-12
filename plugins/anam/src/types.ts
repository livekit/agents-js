// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
export type PersonaConfig = {
  /** Optional display name (prod flow) */
  name?: string;
  /** Optional avatar asset id (prod flow) */
  avatarId?: string;
  /** Optional persona id (dev flow) */
  personaId?: string;
};

export type APIConnectOptions = {
  maxRetry?: number;
  retryInterval?: number; // seconds
  timeout?: number; // seconds
};

export class AnamException extends Error {}
