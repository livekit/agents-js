// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { MintAiTwinAuthTokenOptions, MintAiTwinAuthTokenResult } from './types.js';

const DEFAULT_AUTH_TOKEN_URL =
  'https://us-central1-streamoji-265f4.cloudfunctions.net/getAiTwinAuthToken';

/**
 * Mint a short-lived Ai Twin authToken (client_* JWT) for the browser player.
 * Keep Client-Secret on the server only.
 */
export async function mintAiTwinAuthToken(
  options: MintAiTwinAuthTokenOptions,
): Promise<MintAiTwinAuthTokenResult> {
  const clientId = (options.clientId ?? process.env.AITWIN_CLIENT_ID ?? '').trim();
  const clientSecret = (options.clientSecret ?? process.env.AITWIN_CLIENT_SECRET ?? '').trim();
  const authTokenUrl = (
    options.authTokenUrl ??
    process.env.AITWIN_AUTH_TOKEN_URL ??
    DEFAULT_AUTH_TOKEN_URL
  ).trim();

  if (!clientId || !clientSecret) {
    throw new Error(
      'AITWIN_CLIENT_ID and AITWIN_CLIENT_SECRET are required to mint an auth token',
    );
  }

  const response = await fetch(authTokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Client-Id': clientId,
      'Client-Secret': clientSecret,
    },
    body: JSON.stringify({
      userId: options.userId,
      userName: options.userName ?? options.userId,
      expiresIn: options.expiresIn ?? 60 * 60,
    }),
  });

  const data = (await response.json().catch(() => ({}))) as {
    success?: boolean;
    authToken?: string;
    error?: string;
  };

  if (!response.ok || !data.authToken) {
    throw new Error(data.error || `Ai Twin auth failed (${response.status})`);
  }

  return { authToken: data.authToken };
}
