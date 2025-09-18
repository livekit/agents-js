// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AccessToken } from 'livekit-server-sdk';

export async function createAccessToken(
  apiKey: string,
  apiSecret: string,
  ttl: number = 600,
): Promise<string> {
  const token = new AccessToken(apiKey, apiSecret, { identity: 'agent', ttl });
  token.addInferenceGrant({ perform: true });

  return await token.toJwt();
}
