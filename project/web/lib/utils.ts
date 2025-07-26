export function getLiveKitCredentials() {
  const API_KEY = process.env.LIVEKIT_API_KEY;
  const API_SECRET = process.env.LIVEKIT_API_SECRET;
  const LIVEKIT_URL = process.env.LIVEKIT_URL;

  if (!API_KEY || !API_SECRET || !LIVEKIT_URL) {
    const missing: string[] = [];
    if (!API_KEY) missing.push('LIVEKIT_API_KEY');
    if (!API_SECRET) missing.push('LIVEKIT_API_SECRET');
    if (!LIVEKIT_URL) missing.push('LIVEKIT_URL');

    throw new Error(`Missing LiveKit credentials: ${missing.join(', ')}`);
  }

  return { API_KEY, API_SECRET, LIVEKIT_URL };
}

export async function getLiveKitCredentialsFromRequest(requestJson: any) {
  const { LIVEKIT_URL, LIVEKIT_API_KEY: API_KEY, LIVEKIT_API_SECRET: API_SECRET } = requestJson;

  if (!API_KEY || !API_SECRET || !LIVEKIT_URL) {
    const missing: string[] = [];
    if (!API_KEY) missing.push('LIVEKIT_API_KEY');
    if (!API_SECRET) missing.push('LIVEKIT_API_SECRET');
    if (!LIVEKIT_URL) missing.push('LIVEKIT_URL');

    throw new Error(`Missing LiveKit credentials: ${missing.join(', ')}`);
  }

  return { API_KEY, API_SECRET, LIVEKIT_URL };
}
