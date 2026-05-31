// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { APIConnectionError } from '@livekit/agents';
import { type Server, createServer, globalAgent } from 'node:https';
import { type AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { TTSDefaultVoiceId } from './models.js';
import { ChunkedStream, TTS, type TTSOptions } from './tts.js';

const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQDdJsSNQHi+1BD2
M3O4YzTztWUQxF4UEqHB1zpN2NZQa8KhppQAPMw6UIAJq8bK0wfLeerqkM+CuyAJ
YTJw+s0Fnlg8yVvFqAs0w+PNsBZVHeEs+w+efEC83n6lH1JTi0m5Rf65HfZu1t0L
dIGQoeSxrfP3AX2sBFj6Y/FxV/c7Wfgng0H1/rOMIpYCJHquEbgG41BHFhZXsDio
OckrAmz/mLCv2255sKfwOe/Ap/UTY/C5NIq9cxeYu94HfINsQnNJNKrieY/yOyDW
o5WEFqlP29vfZpeoeQKOZ9NQHKcUk7jBK47TDRsrngkY+Unv3/L2Xws78Bjm8zZP
Oh5zjWn5AgMBAAECggEAZMO2SPn4SlLMC7Hz5y7kwKqFCze9+f1nULAlc7T6KZiA
DTGeO+F32JY3ULDBGkc/RPofDJPAyTtD5KIx3oKYChhU8hV5SD1CJd+fm2fBNTUx
FVKrkjXhNW1XXRtBYqmThOScpHI/h89E1mRWaLUrQ74T7Bb00P0GIciKCW/gSVzj
N/q7W101e8U85Y/UYbUqMbLiuFVmXFSYfA2Uz5CyzAnDZA3Mn9V8OPVN3Aig+xsa
nr4yFpPL65i53GCULx8CedshsgEoUjdL8bf2QAu3YAliliGDElIpJB72p/5jtG4X
b75ezBbiPkl4HQzEYsEabVL/IzSMwLTjaRBDVdHhdQKBgQDxUMX++nkyTGWOxYvO
drisIthdJbKOTwWsNmeWREjZsQN6lSelcgO6WIhGU327lsanlVz9erHZGV5yh8Jk
aoAVHUm/Dn3OBk4Nc669RdJjF6liegIH9VhDTDz6rcQhuYNB6oRzTg/x+6hDEpKZ
q8ZR3SZvlLbV1OMJxQYya3lViwKBgQDqm+CLo2lPNU6v9MYPF9zmn/jXABcLkpKf
b9t3rE3B8CVWfrAtxDr3Sx+fE2sC0ZTKyqh4U8pew1xg76CaV2cET1hKoLNfVjoG
rl/YY49NVCW6s4BGujCsAD+NVC0gb21UJQ4VGCXsRAgzwXL2H5VR3NiV+eNEGw80
SB/f8V3XCwKBgG2M9dXjb9HdzN0b4XRBgWTkDMV8r6rbRQABUtVs+oWZTrL/s5fw
QrD+MB99F79pm5XIwQZyBPtCARaNezqK/sqXGTubIJG/Wv/QXKugXvqNa2BBc1qZ
jxA+NBC5giitR2FNTgPqlGKOlLyeWd9ZlBbmBuTw5m/8zXVJ9J4/HD4xAoGANfj4
VoeYgY1s9dPlALHnsvLYh3XQ12u36ZANOGHeXaCGpnhsxYqgWiXhN3J7KuHWTjUD
PvNf2h8tkGtwUjGLVJWAZWLFAUjP/pt9F0YIQKz8JRCIkTziV5+S/0t/OjgIOdRw
ge/VQZ6BGI8HiJHJg1TASvh7DT8AZ3G0S4u2n/MCgYBswBLFKpJRoJw9j1u352nO
Bl02JrgezU3TGHp1G69Z/eJAC0ZntCZLTKNOI9RzSgpo2u4yhtSm8D5CZoDPFvbE
5zP2PFxsUscFFtjrIIK0G3JSelQQHZY3Ws7HPEEhMYwmYKchrPoUr9PUHAAP4JPU
M/+C1MK7+x4Idr76wAatzQ==
-----END PRIVATE KEY-----`;

const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIDJTCCAg2gAwIBAgIUcdTB1k443l3+KwqBDX93q4eWWXswDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJMTI3LjAuMC4xMB4XDTI2MDUzMTAwMjcyMFoXDTI2MDYw
MTAwMjcyMFowFDESMBAGA1UEAwwJMTI3LjAuMC4xMIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEA3SbEjUB4vtQQ9jNzuGM087VlEMReFBKhwdc6TdjWUGvC
oaaUADzMOlCACavGytMHy3nq6pDPgrsgCWEycPrNBZ5YPMlbxagLNMPjzbAWVR3h
LPsPnnxAvN5+pR9SU4tJuUX+uR32btbdC3SBkKHksa3z9wF9rARY+mPxcVf3O1n4
J4NB9f6zjCKWAiR6rhG4BuNQRxYWV7A4qDnJKwJs/5iwr9tuebCn8DnvwKf1E2Pw
uTSKvXMXmLveB3yDbEJzSTSq4nmP8jsg1qOVhBapT9vb32aXqHkCjmfTUBynFJO4
wSuO0w0bK54JGPlJ79/y9l8LO/AY5vM2Tzoec41p+QIDAQABo28wbTAdBgNVHQ4E
FgQU3gO5QK9TjRUTDhO/5bmwfQBxiWYwHwYDVR0jBBgwFoAU3gO5QK9TjRUTDhO/
5bmwfQBxiWYwDwYDVR0TAQH/BAUwAwEB/zAaBgNVHREEEzARhwR/AAABgglsb2Nh
bGhvc3QwDQYJKoZIhvcNAQELBQADggEBAG05mHdvtuKMjwIM020tZT7g44C5sj7Z
r6+mDhT9I80o+0TG9j2sCtlZ4u0MdLdZ3dPniL9oGwQMoXxrU/8e3CRr0IqWYvQo
yq7qdFJHxJOAUpKiS//udR3sCm6jR24vKkoFaPBqzlP+08LyYRrkp15YVckjiCAN
fEcmZIpDpo1jVZArGGYNm1swWqClR8Hbx4bdvZzJBhME4x6kqvysaN1344g1/JY1
ohfDd+UabmLytr1BVMfr1bsgawvtXH42EY1GfZmk/KIGCeHxOXwOeXx/EoLlEPR6
LAvz0eFhc1o0YOnZIL+1uHuqqkkIzOofdwPJ69RfhCYSYjkHvyaEWZU=
-----END CERTIFICATE-----`;

class TestChunkedStream extends ChunkedStream {
  protected async run() {
    return;
  }

  runForTest() {
    return super.run();
  }
}

const listen = (server: Server) =>
  new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve((server.address() as AddressInfo).port);
    });
  });

const close = (server: Server) =>
  new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });

describe('Cartesia ChunkedStream HTTP errors', () => {
  it('rejects non-2xx responses instead of treating the body as audio', async () => {
    const server = createServer({ key: TEST_KEY, cert: TEST_CERT }, (_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid API key' }));
    });
    const port = await listen(server);
    const originalCa = globalAgent.options.ca;
    globalAgent.options.ca = TEST_CERT;

    const opts: TTSOptions = {
      model: 'sonic-3',
      encoding: 'pcm_s16le',
      sampleRate: 24000,
      voice: TTSDefaultVoiceId,
      apiKey: 'invalid-key',
      language: 'en',
      baseUrl: `https://127.0.0.1:${port}`,
      apiVersion: '2025-04-16',
      chunkTimeout: 5000,
      wordTimestamps: true,
    };
    const tts = new TTS(opts);
    const stream = new TestChunkedStream(tts, 'hi', opts, {
      maxRetry: 0,
      retryIntervalMs: 0,
      timeoutMs: 1000,
    });

    await Promise.resolve();
    try {
      await expect(stream.runForTest()).rejects.toBeInstanceOf(APIConnectionError);
      await expect(stream.next()).resolves.toEqual({ value: undefined, done: true });
    } finally {
      stream.close();
      globalAgent.options.ca = originalCa;
      await close(server);
    }
  });
});
