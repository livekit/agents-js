// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { APIStatusError, DEFAULT_API_CONNECT_OPTIONS, log } from '@livekit/agents';
import { VAD } from '@livekit/agents-plugin-silero';
import { stt } from '@livekit/agents-plugins-test';
import { AudioFrame } from '@livekit/rtc-node';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import { STT } from './stt.js';

const hasDeepgramApiKey = Boolean(process.env.DEEPGRAM_API_KEY);

function makeFrame(samplesPerChannel: number, sampleRate = 16000): AudioFrame {
  const data = new Int16Array(samplesPerChannel);
  data.fill(1);
  return new AudioFrame(data, sampleRate, 1, samplesPerChannel);
}

async function startWebSocketServer() {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(wss, 'listening');
  const address = wss.address() as AddressInfo;
  return { wss, baseUrl: `ws://127.0.0.1:${address.port}` };
}

async function closeWebSocketServer(wss: WebSocketServer): Promise<void> {
  for (const client of wss.clients) client.close();
  await new Promise<void>((resolve) => wss.close(() => resolve()));
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for condition');
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Deepgram streaming language detection', () => {
  // Deepgram only supports language detection for prerecorded audio, so a
  // streaming session must reject it rather than silently default to English.
  // Mirrors livekit-plugins-deepgram (Python).
  it('throws when starting a stream with detectLanguage enabled', () => {
    const stt = new STT({ apiKey: 'test', detectLanguage: true });
    expect(() => stt.stream()).toThrow('language detection is not supported in streaming mode');
  });

  it('allows streaming with an explicit language', () => {
    const stt = new STT({ apiKey: 'test', language: 'en-US' });
    const stream = stt.stream();
    // Close immediately so the connection loop never starts (no network in unit tests).
    stream.close();
  });
});

describe('Deepgram WebSocket handshake', () => {
  it('redacts API keys from rejected handshakes', async () => {
    const secret = 'secret-api-key-do-not-log';
    const wss = new WebSocketServer({
      host: '127.0.0.1',
      port: 0,
      verifyClient: (_info, done) => done(false, 401, 'Unauthorized'),
    });
    await once(wss, 'listening');
    const address = wss.address() as AddressInfo;
    const deepgram = new STT({
      apiKey: secret,
      baseUrl: `ws://127.0.0.1:${address.port}`,
    });
    const errorEvent = once(deepgram, 'error');
    const stream = deepgram.stream({
      connOptions: { ...DEFAULT_API_CONNECT_OPTIONS, maxRetry: 0 },
    });

    try {
      const [{ error }] = await errorEvent;
      expect(error).toBeInstanceOf(APIStatusError);
      expect((error as APIStatusError).statusCode).toBe(401);
      expect(error.message).not.toContain(secret);
      expect(error.toString()).not.toContain(secret);
    } finally {
      stream.close();
      await closeWebSocketServer(wss);
    }
  });
});

describe('Deepgram streaming flush', () => {
  it('finalizes the turn when no audio is left to send', async () => {
    const { wss, baseUrl } = await startWebSocketServer();
    const wire: string[] = [];
    wss.on('connection', (ws) => {
      ws.on('message', (data, isBinary) => {
        wire.push(isBinary ? 'audio' : (JSON.parse(data.toString()) as { type: string }).type);
      });
    });

    const stream = new STT({ apiKey: 'test-key', baseUrl }).stream();
    try {
      // 100ms is exactly one JS repack chunk, so flush() returns no frames.
      stream.pushFrame(makeFrame(1600));
      await waitUntil(() => wire.join(',') === 'audio');

      stream.flush();
      await waitUntil(() => wire.join(',') === 'audio,Finalize');
    } finally {
      stream.close();
      await closeWebSocketServer(wss);
    }
  });

  it('finalizes after the buffered audio', async () => {
    const { wss, baseUrl } = await startWebSocketServer();
    const wire: string[] = [];
    wss.on('connection', (ws) => {
      ws.on('message', (data, isBinary) => {
        wire.push(isBinary ? 'audio' : (JSON.parse(data.toString()) as { type: string }).type);
      });
    });

    const stream = new STT({ apiKey: 'test-key', baseUrl }).stream();
    try {
      stream.pushFrame(makeFrame(480));
      stream.flush();
      await waitUntil(() => wire.join(',') === 'audio,Finalize');
    } finally {
      stream.close();
      await closeWebSocketServer(wss);
    }
  });
});

describe('Deepgram streaming language hints', () => {
  it('sends language_hint once per language in multi language mode', async () => {
    const { wss, baseUrl } = await startWebSocketServer();
    const urls: string[] = [];
    wss.on('connection', (_socket, request) => urls.push(request.url ?? ''));

    const stream = new STT({
      apiKey: 'test-key',
      baseUrl,
      language: 'multi',
      languageHint: ['en', 'es'],
    }).stream();
    try {
      await waitUntil(() => urls.length > 0);
      const url = new URL(urls[0]!, 'ws://127.0.0.1');
      expect(url.searchParams.getAll('language_hint')).toEqual(['en', 'es']);
      expect(url.searchParams.get('language')).toBe('multi');
    } finally {
      stream.close();
      await closeWebSocketServer(wss);
    }
  });

  it('leaves the hint off the wire and warns once for any other language', async () => {
    const warnSpy = vi.spyOn(log(), 'warn');
    const { wss, baseUrl } = await startWebSocketServer();
    const urls: string[] = [];
    wss.on('connection', (_socket, request) => urls.push(request.url ?? ''));

    const stream = new STT({
      apiKey: 'test-key',
      baseUrl,
      language: 'en-US',
      languageHint: ['en', 'es'],
    }).stream();
    try {
      await waitUntil(() => urls.length > 0);
      expect(urls[0]).not.toContain('language_hint');
      expect(warnSpy).toHaveBeenCalledExactlyOnceWith(
        { model: 'nova-3', language: 'en-US' },
        'Ignoring `languageHint`: it only applies to nova-3 with language "multi"',
      );
    } finally {
      stream.close();
      await closeWebSocketServer(wss);
    }
  });

  // nova-3-general is the same multilingual model as nova-3 (Deepgram's model table lists them on
  // one row), so the validator must not rewrite it the way it does the English-only nova-2 tiers.
  it('sends the hint on nova-3-general in multi mode', async () => {
    const warnSpy = vi.spyOn(log(), 'warn');
    const { wss, baseUrl } = await startWebSocketServer();
    const urls: string[] = [];
    wss.on('connection', (_socket, request) => urls.push(request.url ?? ''));

    const stream = new STT({
      apiKey: 'test-key',
      baseUrl,
      model: 'nova-3-general',
      language: 'multi',
      languageHint: ['en'],
    }).stream();
    try {
      await waitUntil(() => urls.length > 0);
      expect(urls[0]).toContain('model=nova-3-general');
      expect(urls[0]).toContain('language_hint=en');
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      stream.close();
      await closeWebSocketServer(wss);
    }
  });

  it('keeps nova-3-general for a non-English language instead of falling back', async () => {
    const warnSpy = vi.spyOn(log(), 'warn');
    const { wss, baseUrl } = await startWebSocketServer();
    const urls: string[] = [];
    wss.on('connection', (_socket, request) => urls.push(request.url ?? ''));

    const stream = new STT({
      apiKey: 'test-key',
      baseUrl,
      model: 'nova-3-general',
      language: 'es',
    }).stream();
    try {
      await waitUntil(() => urls.length > 0);
      expect(urls[0]).toContain('model=nova-3-general');
      expect(urls[0]).toContain('language=es');
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      stream.close();
      await closeWebSocketServer(wss);
    }
  });

  it('leaves the hint off the wire and warns when the model is not nova-3, even in multi mode', async () => {
    const warnSpy = vi.spyOn(log(), 'warn');
    const { wss, baseUrl } = await startWebSocketServer();
    const urls: string[] = [];
    wss.on('connection', (_socket, request) => urls.push(request.url ?? ''));

    const stream = new STT({
      apiKey: 'test-key',
      baseUrl,
      model: 'nova-2-general',
      language: 'multi',
      languageHint: ['en', 'es'],
    }).stream();
    try {
      await waitUntil(() => urls.length > 0);
      expect(urls[0]).not.toContain('language_hint');
      expect(warnSpy).toHaveBeenCalledExactlyOnceWith(
        { model: 'nova-2-general', language: 'multi' },
        'Ignoring `languageHint`: it only applies to nova-3 with language "multi"',
      );
    } finally {
      stream.close();
      await closeWebSocketServer(wss);
    }
  });

  it('leaves the hint off the wire on nova-3-medical, which the gateway also excludes', async () => {
    const warnSpy = vi.spyOn(log(), 'warn');
    const { wss, baseUrl } = await startWebSocketServer();
    const urls: string[] = [];
    wss.on('connection', (_socket, request) => urls.push(request.url ?? ''));

    const stream = new STT({
      apiKey: 'test-key',
      baseUrl,
      model: 'nova-3-medical',
      language: 'multi',
      languageHint: ['en', 'es'],
    }).stream();
    try {
      await waitUntil(() => urls.length > 0);
      expect(urls[0]).not.toContain('language_hint');
      expect(warnSpy).toHaveBeenCalledExactlyOnceWith(
        { model: 'nova-3-medical', language: 'multi' },
        'Ignoring `languageHint`: it only applies to nova-3 with language "multi"',
      );
    } finally {
      stream.close();
      await closeWebSocketServer(wss);
    }
  });

  it('stops sending the hint when the language leaves multi', async () => {
    const { wss, baseUrl } = await startWebSocketServer();
    const urls: string[] = [];
    const wire: string[] = [];
    wss.on('connection', (socket, request) => {
      urls.push(request.url ?? '');
      socket.on('message', (_data, isBinary) => {
        if (isBinary) wire.push('audio');
      });
    });

    const provider = new STT({
      apiKey: 'test-key',
      baseUrl,
      language: 'multi',
      languageHint: ['en', 'es'],
    });
    const stream = provider.stream({
      connOptions: { ...DEFAULT_API_CONNECT_OPTIONS, maxRetry: 0, retryIntervalMs: 1 },
    });
    try {
      // The first audio frame proves the stream reached its connection loop, so the update below
      // cannot race the initial connect and get dropped.
      stream.pushFrame(makeFrame(1600));
      await waitUntil(() => wire.length > 0);
      expect(urls[0]).toContain('language_hint=en');

      stream.updateOptions({ language: 'en-US' });

      await waitUntil(() => urls.length === 2);
      expect(urls[1]).not.toContain('language_hint');
    } finally {
      stream.close();
      await closeWebSocketServer(wss);
    }
  });

  // The hint belongs to the caller's configuration, so a language that stops applying it must not
  // delete it: coming back to `multi` has to put it on the wire again.
  it('sends the hint again when the language returns to multi', async () => {
    const { wss, baseUrl } = await startWebSocketServer();
    const urls: string[] = [];
    const wire: string[] = [];
    wss.on('connection', (socket, request) => {
      urls.push(request.url ?? '');
      socket.on('message', (_data, isBinary) => {
        if (isBinary) wire.push('audio');
      });
    });

    const stream = new STT({
      apiKey: 'test-key',
      baseUrl,
      language: 'multi',
      languageHint: ['en', 'es'],
    }).stream({
      connOptions: { ...DEFAULT_API_CONNECT_OPTIONS, maxRetry: 0, retryIntervalMs: 1 },
    });
    try {
      stream.pushFrame(makeFrame(1600));
      await waitUntil(() => wire.length > 0);
      expect(urls[0]).toContain('language_hint=en');

      stream.updateOptions({ language: 'en-US' });
      await waitUntil(() => urls.length === 2);
      expect(urls[1]).not.toContain('language_hint');

      stream.updateOptions({ language: 'multi' });
      await waitUntil(() => urls.length === 3);
      expect(urls[2]).toContain('language_hint=en');
      expect(urls[2]).toContain('language_hint=es');
      expect(urls[2]).toContain('language=multi');
    } finally {
      stream.close();
      await closeWebSocketServer(wss);
    }
  });

  it('keeps a hint configured on a language that cannot apply it', async () => {
    const { wss, baseUrl } = await startWebSocketServer();
    const urls: string[] = [];
    const wire: string[] = [];
    wss.on('connection', (socket, request) => {
      urls.push(request.url ?? '');
      socket.on('message', (_data, isBinary) => {
        if (isBinary) wire.push('audio');
      });
    });

    const stream = new STT({
      apiKey: 'test-key',
      baseUrl,
      language: 'en-US',
      languageHint: ['en', 'es'],
    }).stream({
      connOptions: { ...DEFAULT_API_CONNECT_OPTIONS, maxRetry: 0, retryIntervalMs: 1 },
    });
    try {
      stream.pushFrame(makeFrame(1600));
      await waitUntil(() => wire.length > 0);
      expect(urls[0]).not.toContain('language_hint');

      stream.updateOptions({ language: 'multi' });
      await waitUntil(() => urls.length === 2);
      expect(urls[1]).toContain('language_hint=en');
      expect(urls[1]).toContain('language_hint=es');
    } finally {
      stream.close();
      await closeWebSocketServer(wss);
    }
  });

  it('keeps the hint across provider updates that stop it applying', async () => {
    const { wss, baseUrl } = await startWebSocketServer();
    const urls: string[] = [];
    wss.on('connection', (_socket, request) => urls.push(request.url ?? ''));

    const provider = new STT({
      apiKey: 'test-key',
      baseUrl,
      language: 'multi',
      languageHint: ['en', 'es'],
    });
    provider.updateOptions({ language: 'en-US' });
    provider.updateOptions({ language: 'multi' });

    // a stream built after the round trip reads the provider's options, which the round trip
    // must not have emptied
    const stream = provider.stream({
      connOptions: { ...DEFAULT_API_CONNECT_OPTIONS, maxRetry: 0, retryIntervalMs: 1 },
    });
    try {
      await waitUntil(() => urls.length > 0);
      expect(urls[0]).toContain('language_hint=en');
      expect(urls[0]).toContain('language_hint=es');
    } finally {
      stream.close();
      await closeWebSocketServer(wss);
    }
  });
});

if (hasDeepgramApiKey) {
  describe('Deepgram', async () => {
    await stt(new STT(), await VAD.load(), { nonStreaming: false });
  });
} else {
  describe('Deepgram', () => {
    it.skip('requires DEEPGRAM_API_KEY', () => {});
  });
}
