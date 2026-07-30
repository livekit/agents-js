// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { once } from 'node:events';
import type { IncomingMessage } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { WebSocketServer } from 'ws';
import type { ProviderData } from './provider_data.js';
import { RealtimeModel, RealtimeSession, buildWsUrl } from './realtime_model.js';

const API_KEY = 'aW53b3JsZC10ZXN0LWtleQ==';

// Inworld adds fields OpenAI types do not model; assert against raw wire JSON.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type WireEvent = Record<string, any>;

/** Local WS server; session dials in the constructor so assertions need a real peer. */
interface TestServer {
  baseURL: string;
  firstRequest: Promise<IncomingMessage>;
  firstEvent: Promise<WireEvent>;
  close: () => Promise<void>;
}

async function startServer(): Promise<TestServer> {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');

  const address = server.address();
  if (typeof address === 'string' || address === null) {
    throw new Error('expected websocket server to listen on a TCP port');
  }

  let resolveRequest: (req: IncomingMessage) => void;
  const firstRequest = new Promise<IncomingMessage>((resolve) => {
    resolveRequest = resolve;
  });

  let resolveEvent: (event: WireEvent) => void;
  const firstEvent = new Promise<WireEvent>((resolve) => {
    resolveEvent = resolve;
  });

  const sockets: WebSocket[] = [];
  server.on('connection', (socket, request) => {
    sockets.push(socket);
    resolveRequest(request);
    socket.once('message', (data) => {
      resolveEvent(JSON.parse(data.toString()));
    });
  });

  return {
    baseURL: `http://127.0.0.1:${address.port}/api/v1/realtime/session`,
    firstRequest,
    firstEvent,
    close: async () => {
      for (const socket of sockets) socket.terminate();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

describe('buildWsUrl', () => {
  it('sets the required query parameters', () => {
    const url = new URL(buildWsUrl('wss://api.inworld.ai/api/v1/realtime/session'));

    expect(url.protocol).toBe('wss:');
    expect(url.host).toBe('api.inworld.ai');
    expect(url.pathname).toBe('/api/v1/realtime/session');
    expect(url.searchParams.get('protocol')).toBe('realtime');
    expect(url.searchParams.get('key')).toMatch(/^session_/);
  });

  it('does not append the OpenAI /realtime path segment or a model parameter', () => {
    const url = new URL(buildWsUrl('wss://api.inworld.ai/api/v1/realtime/session'));

    expect(url.pathname.endsWith('/realtime')).toBe(false);
    expect(url.searchParams.has('model')).toBe(false);
  });

  it('converts http to ws and https to wss', () => {
    expect(buildWsUrl('http://localhost:9000/session')).toMatch(/^ws:\/\/localhost:9000\/session/);
    expect(buildWsUrl('https://api.inworld.ai/session')).toMatch(
      /^wss:\/\/api\.inworld\.ai\/session/,
    );
  });

  it('leaves ws and wss schemes untouched', () => {
    expect(buildWsUrl('ws://localhost:9000/session')).toMatch(/^ws:\/\//);
    expect(buildWsUrl('wss://api.inworld.ai/session')).toMatch(/^wss:\/\//);
  });

  it('preserves an explicitly supplied key', () => {
    const url = new URL(buildWsUrl('wss://api.inworld.ai/session?key=my-own-key'));

    expect(url.searchParams.get('key')).toBe('my-own-key');
    expect(url.searchParams.get('protocol')).toBe('realtime');
  });

  it('generates a distinct key per call', () => {
    const first = new URL(buildWsUrl('wss://api.inworld.ai/session')).searchParams.get('key');
    const second = new URL(buildWsUrl('wss://api.inworld.ai/session')).searchParams.get('key');

    expect(first).not.toBe(second);
  });
});

describe('RealtimeModel defaults', () => {
  it('applies the Inworld defaults', () => {
    const model = new RealtimeModel({ apiKey: API_KEY });

    expect(model.model).toBe('google-ai-studio/gemini-3.1-flash-lite');
    expect(model._options.voice).toBe('Ashley');
    expect(model._options.baseURL).toBe('wss://api.inworld.ai/api/v1/realtime/session');
    expect(model._ttsModel).toBe('inworld-tts-2');
    expect(model._options.inputAudioTranscription).toEqual({
      model: 'inworld/inworld-stt-1',
    });
    expect(model._providerData).toEqual({
      auto_tool_response: false,
      caching: { enabled: true },
    });
  });

  it('reports the Inworld provider and label instead of deriving them from the URL', () => {
    const model = new RealtimeModel({ apiKey: API_KEY });

    expect(model.provider).toBe('Inworld');
    expect(model.label()).toBe('inworld.RealtimeModel');
  });

  it('leaves tool reply generation to the agent', () => {
    const model = new RealtimeModel({ apiKey: API_KEY });

    expect(model.capabilities.autoToolReplyGeneration).toBe(false);
  });

  it('honours explicit overrides', () => {
    const model = new RealtimeModel({
      apiKey: API_KEY,
      model: 'anthropic/claude-sonnet-4',
      voice: 'Jason',
      ttsModel: 'inworld-tts-1.5-max',
      sttModel: 'inworld/inworld-stt-2',
      baseURL: 'wss://example.test/session',
    });

    expect(model.model).toBe('anthropic/claude-sonnet-4');
    expect(model._options.voice).toBe('Jason');
    expect(model._ttsModel).toBe('inworld-tts-1.5-max');
    expect(model._options.inputAudioTranscription).toEqual({ model: 'inworld/inworld-stt-2' });
    expect(model._options.baseURL).toBe('wss://example.test/session');
  });

  it('merges providerData over the defaults', () => {
    const model = new RealtimeModel({
      apiKey: API_KEY,
      providerData: { user_id: 'user-1', tts: { delivery_mode: 'BALANCED' } },
    });

    expect(model._providerData).toEqual({
      auto_tool_response: false,
      caching: { enabled: true },
      user_id: 'user-1',
      tts: { delivery_mode: 'BALANCED' },
    });
  });

  it('forces auto_tool_response to false even when requested', () => {
    const model = new RealtimeModel({
      apiKey: API_KEY,
      providerData: { auto_tool_response: true },
    });

    expect(model._providerData.auto_tool_response).toBe(false);
    expect(model.capabilities.autoToolReplyGeneration).toBe(false);
  });

  it('merges caching overrides over the enabled default', () => {
    const model = new RealtimeModel({
      apiKey: API_KEY,
      providerData: { caching: { ttl: '5m', cache_tools: false } },
    });

    expect(model._providerData.caching).toEqual({
      enabled: true,
      ttl: '5m',
      cache_tools: false,
    });
  });

  it('allows caching to be turned off explicitly', () => {
    const model = new RealtimeModel({
      apiKey: API_KEY,
      providerData: { caching: { enabled: false } },
    });

    expect(model._providerData.caching).toEqual({ enabled: false });
  });
});

describe('RealtimeModel API key resolution', () => {
  const original = process.env.INWORLD_API_KEY;

  beforeEach(() => {
    delete process.env.INWORLD_API_KEY;
  });

  afterEach(() => {
    if (original === undefined) {
      delete process.env.INWORLD_API_KEY;
    } else {
      process.env.INWORLD_API_KEY = original;
    }
  });

  it('reads INWORLD_API_KEY from the environment', () => {
    process.env.INWORLD_API_KEY = 'env-key';
    const model = new RealtimeModel();

    expect(model._options.apiKey).toBe('env-key');
  });

  it('throws when no key is available', () => {
    expect(() => new RealtimeModel()).toThrow(/INWORLD_API_KEY/);
  });

  it('prefers the explicit argument over the environment', () => {
    process.env.INWORLD_API_KEY = 'env-key';
    const model = new RealtimeModel({ apiKey: 'arg-key' });

    expect(model._options.apiKey).toBe('arg-key');
  });
});

describe('RealtimeSession connection errors', () => {
  it('rejects refused connections without an uncaught exception', async () => {
    const uncaught: Error[] = [];
    const onUncaught = (error: Error) => {
      uncaught.push(error);
    };
    process.on('uncaughtException', onUncaught);

    try {
      const model = new RealtimeModel({
        apiKey: API_KEY,
        // Port 1 is almost always closed → ECONNREFUSED during the handshake.
        baseURL: 'ws://127.0.0.1:1/session',
        connOptions: { maxRetry: 0, retryIntervalMs: 100, timeoutMs: 2000 },
      });
      const session = model.session();

      // Give the handshake time to fail; the error listener should reject cleanly.
      await new Promise((resolve) => setTimeout(resolve, 500));
      await session.close().catch(() => undefined);

      expect(uncaught).toEqual([]);
    } finally {
      process.off('uncaughtException', onUncaught);
    }
  });
});

describe('RealtimeSession wire format', () => {
  let server: TestServer;

  beforeEach(async () => {
    server = await startServer();
  });

  afterEach(async () => {
    await server.close();
  });

  it('authenticates with the base64 key as an HTTP Basic credential', async () => {
    const model = new RealtimeModel({ apiKey: API_KEY, baseURL: server.baseURL });
    const session = model.session();

    try {
      const request = await server.firstRequest;

      expect(request.headers.authorization).toBe(`Basic ${API_KEY}`);
      expect(request.headers['user-agent']).toBe('LiveKit Agents');
      expect(request.url).toContain('protocol=realtime');
      expect(request.url).toContain('key=session_');
      expect(request.url).not.toContain('model=');
    } finally {
      await session.close().catch(() => undefined);
    }
  });

  it('sends Inworld fields on the initial session.update', async () => {
    const providerData: ProviderData = {
      stt: { language_code: 'en-US', enable_automatic_punctuation: true },
      tts: { delivery_mode: 'CREATIVE', timestamp_type: 'WORD' },
      text_generation_config: { maxNewTokens: 256, topP: 0.9 },
      memory: { enabled: true, user_id: 'user-1' },
    };
    const model = new RealtimeModel({
      apiKey: API_KEY,
      baseURL: server.baseURL,
      providerData,
    });
    const session = model.session();

    try {
      const event = await server.firstEvent;

      expect(event.type).toBe('session.update');
      expect(event.session.model).toBe('google-ai-studio/gemini-3.1-flash-lite');
      expect(event.session.audio.output.voice).toBe('Ashley');
      expect(event.session.audio.output.model).toBe('inworld-tts-2');
      expect(event.session.audio.input.transcription).toEqual({
        model: 'inworld/inworld-stt-1',
      });
      expect(event.session.providerData).toEqual({
        auto_tool_response: false,
        caching: { enabled: true },
        ...providerData,
      });
      // camelCase keys in text_generation_config must survive verbatim.
      expect(event.session.providerData.text_generation_config).toEqual({
        maxNewTokens: 256,
        topP: 0.9,
      });
    } finally {
      await session.close().catch(() => undefined);
    }
  });

  it('sends auto_tool_response false on the wire even when requested true', async () => {
    const model = new RealtimeModel({
      apiKey: API_KEY,
      baseURL: server.baseURL,
      providerData: { auto_tool_response: true },
    });
    const session = model.session();

    try {
      const event = await server.firstEvent;

      expect(event.session.providerData.auto_tool_response).toBe(false);
    } finally {
      await session.close().catch(() => undefined);
    }
  });

  // Regression: hooks run inside super(); subclass fields would be clobbered by useDefineForClassFields.
  it('populates the Inworld fields even though the hooks run inside super()', async () => {
    const model = new RealtimeModel({
      apiKey: API_KEY,
      baseURL: server.baseURL,
      ttsModel: 'inworld-tts-1.5-max',
      providerData: { user_id: 'ordering-check' },
    });
    const session = model.session();

    expect(session).toBeInstanceOf(RealtimeSession);

    try {
      const event = await server.firstEvent;

      expect(event.type).toBe('session.update');
      expect(event.session.audio.output.model).toBe('inworld-tts-1.5-max');
      expect(event.session.providerData).toEqual({
        auto_tool_response: false,
        caching: { enabled: true },
        user_id: 'ordering-check',
      });
    } finally {
      await session.close().catch(() => undefined);
    }
  });
});
