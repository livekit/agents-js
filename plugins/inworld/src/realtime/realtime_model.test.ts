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

/**
 * Loosely-typed view of a parsed wire event. The `any` is deliberate: these assertions walk the raw
 * JSON that actually crossed the socket, which is precisely what the compile-time event types cannot
 * describe (Inworld adds fields the OpenAI types do not model).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type WireEvent = Record<string, any>;

/**
 * The Inworld session dials immediately from its constructor, so wire-level assertions need a real
 * server on the other end. Mirrors the fixture style in
 * plugins/openai/src/realtime/realtime_model.test.ts.
 */
interface TestServer {
  baseURL: string;
  /** Resolves with the upgrade request of the first connection. */
  firstRequest: Promise<IncomingMessage>;
  /** Resolves with the first client event received, parsed. */
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
      // WebSocketServer.close() waits on live clients, so hang up on them first.
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

    expect(model.model).toBe('openai/gpt-4o-mini');
    expect(model._options.voice).toBe('Ashley');
    expect(model._options.baseURL).toBe('wss://api.inworld.ai/api/v1/realtime/session');
    expect(model._ttsModel).toBe('inworld-tts-2');
    expect(model._options.inputAudioTranscription).toEqual({
      model: 'inworld/inworld-stt-1',
    });
    expect(model._providerData).toEqual({ auto_tool_response: false });
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

  it('merges providerData over the auto_tool_response default', () => {
    const model = new RealtimeModel({
      apiKey: API_KEY,
      providerData: { user_id: 'user-1', tts: { delivery_mode: 'BALANCED' } },
    });

    expect(model._providerData).toEqual({
      auto_tool_response: false,
      user_id: 'user-1',
      tts: { delivery_mode: 'BALANCED' },
    });
  });

  it('allows auto_tool_response to be turned on explicitly', () => {
    const model = new RealtimeModel({
      apiKey: API_KEY,
      providerData: { auto_tool_response: true },
    });

    expect(model._providerData.auto_tool_response).toBe(true);
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
      expect(event.session.model).toBe('openai/gpt-4o-mini');
      expect(event.session.audio.output.voice).toBe('Ashley');
      expect(event.session.audio.output.model).toBe('inworld-tts-2');
      expect(event.session.audio.input.transcription).toEqual({
        model: 'inworld/inworld-stt-1',
      });
      expect(event.session.providerData).toEqual({
        auto_tool_response: false,
        ...providerData,
      });
      // Casing is mixed on purpose and must survive serialization verbatim.
      expect(event.session.providerData.text_generation_config).toEqual({
        maxNewTokens: 256,
        topP: 0.9,
      });
    } finally {
      await session.close().catch(() => undefined);
    }
  });

  it('propagates an auto_tool_response override to the wire', async () => {
    const model = new RealtimeModel({
      apiKey: API_KEY,
      baseURL: server.baseURL,
      providerData: { auto_tool_response: true },
    });
    const session = model.session();

    try {
      const event = await server.firstEvent;

      expect(event.session.providerData.auto_tool_response).toBe(true);
    } finally {
      await session.close().catch(() => undefined);
    }
  });

  // Regression test for the constructor ordering trap.
  //
  // Both overridden hooks run *inside* the base class constructor, and the repo compiles with
  // `useDefineForClassFields`, so any instance field declared on the Inworld session would be
  // defined to `undefined` only after `super()` returns — silently dropping `audio.output.model`
  // and `providerData` from the very first session.update. A real session (not a prototype stub) is
  // required to catch this.
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
        user_id: 'ordering-check',
      });
    } finally {
      await session.close().catch(() => undefined);
    }
  });
});
