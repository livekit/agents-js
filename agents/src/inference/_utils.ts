// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AccessToken } from 'livekit-server-sdk';

export function createAccessToken(
  apiKey: string,
  apiSecret: string,
  ttlSeconds: number = 600,
): string {
  const token = new AccessToken(apiKey, apiSecret, { ttl: ttlSeconds });
  return '';
}
