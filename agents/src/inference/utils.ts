// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AccessToken } from 'livekit-server-sdk';

export async function createAccessToken(apiKey: string, apiSecret: string): Promise<string> {
  const token = new AccessToken(apiKey, apiSecret, { ttl: 600 });
  return await token.toJwt();
}
