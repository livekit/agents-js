// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AccessToken } from 'livekit-server-sdk';

export async function createAccessToken(
  apiKey: string,
  apiSecret: string,
  ttlSeconds: number = 600,
): Promise<string> {
  const token = new AccessToken(apiKey, apiSecret, { ttl: ttlSeconds });
  // Grant permission to perform inference via the Agent Gateway
  token.addGrant({ inference: { perform: true } });
  return await token.toJwt();
}
