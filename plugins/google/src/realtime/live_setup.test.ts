// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { HistoryConfig } from '@google/genai';
import { GoogleGenAI } from '@google/genai';
import { describe, expect, it } from 'vitest';
import {
  type LiveSocketHost,
  forwardHistoryConfigToSetup,
  historyConfigForSetup,
} from './live_setup.js';

/** Records every frame handed to `WebSocket.send()` for one connection. */
class FakeWebSocket {
  readonly sent: string[] = [];

  connect(): void {}

  send(message: string): void {
    this.sent.push(message);
  }

  close(): void {}
}

class FakeWebSocketFactory {
  readonly sockets: FakeWebSocket[] = [];

  create(): FakeWebSocket {
    const socket = new FakeWebSocket();
    this.sockets.push(socket);
    return socket;
  }
}

/**
 * Stands in for `GoogleGenAI`, which owns the websocket factory that
 * `live.connect()` uses to open a session.
 */
function fakeClient() {
  const factory = new FakeWebSocketFactory();
  return { client: { live: { webSocketFactory: factory } }, factory };
}

/** The setup frame `live.connect()` builds and sends before anything else. */
const SETUP_FRAME = JSON.stringify({
  setup: { model: 'models/gemini-3.1-flash-live-preview', generationConfig: {} },
});

function setupFrameOf(socket: FakeWebSocket): Record<string, unknown> {
  return JSON.parse(socket.sent[0]!).setup;
}

const HISTORY_CONFIG: HistoryConfig = { initialHistoryInClientContent: true };

describe('forwardHistoryConfigToSetup', () => {
  it('adds historyConfig to the setup frame', () => {
    const { client } = fakeClient();

    forwardHistoryConfigToSetup(client, HISTORY_CONFIG);

    const socket = client.live.webSocketFactory.create();
    socket.send(SETUP_FRAME);

    expect(setupFrameOf(socket).historyConfig).toEqual({ initialHistoryInClientContent: true });
  });

  it('keeps the setup fields the SDK already built', () => {
    const { client } = fakeClient();

    forwardHistoryConfigToSetup(client, HISTORY_CONFIG);

    const socket = client.live.webSocketFactory.create();
    socket.send(SETUP_FRAME);

    expect(setupFrameOf(socket)).toMatchObject({
      model: 'models/gemini-3.1-flash-live-preview',
      generationConfig: {},
    });
  });

  it('leaves every frame after setup untouched', () => {
    const { client } = fakeClient();

    forwardHistoryConfigToSetup(client, HISTORY_CONFIG);

    const socket = client.live.webSocketFactory.create();
    const clientContent = JSON.stringify({
      clientContent: { turns: [{ role: 'user', parts: [{ text: 'hi' }] }], turnComplete: false },
    });
    const realtimeInput = JSON.stringify({
      realtimeInput: { audio: { mimeType: 'audio/pcm', data: 'AAAA' } },
    });

    socket.send(SETUP_FRAME);
    socket.send(clientContent);
    socket.send(realtimeInput);

    expect(socket.sent.slice(1)).toEqual([clientContent, realtimeInput]);
  });

  it('applies to reconnects, not just the first socket', () => {
    const { client } = fakeClient();

    forwardHistoryConfigToSetup(client, HISTORY_CONFIG);

    const first = client.live.webSocketFactory.create();
    first.send(SETUP_FRAME);
    const second = client.live.webSocketFactory.create();
    second.send(SETUP_FRAME);

    expect(setupFrameOf(first).historyConfig).toEqual({ initialHistoryInClientContent: true });
    expect(setupFrameOf(second).historyConfig).toEqual({ initialHistoryInClientContent: true });
  });

  it('reports failure when the SDK no longer exposes a socket factory', () => {
    expect(forwardHistoryConfigToSetup({ live: {} }, HISTORY_CONFIG)).toBe(false);
  });
});

/**
 * Drives the real `live.connect()` so the setup frame is the one the SDK
 * actually builds. Guards the two assumptions the workaround rests on: that the
 * SDK drops `historyConfig` from the connect config, and that the socket the
 * hook wraps is the one `connect()` uses.
 */
describe('forwardHistoryConfigToSetup against the real SDK', () => {
  interface SocketCallbacks {
    onopen: () => void;
    onmessage: (event: { data: string }) => void;
  }

  /** Accepts the handshake so `connect()` resolves, and records what was sent. */
  class HandshakeWebSocket {
    readonly sent: string[] = [];

    constructor(private readonly callbacks: SocketCallbacks) {}

    connect(): void {
      this.callbacks.onopen();
    }

    send(message: string): void {
      this.sent.push(message);
      if (this.sent.length === 1) {
        this.callbacks.onmessage({ data: JSON.stringify({ setupComplete: {} }) });
      }
    }

    close(): void {}
  }

  async function connectAndCaptureSetup(options: {
    fromHook?: HistoryConfig;
    onConnectConfig?: HistoryConfig;
  }) {
    const client = new GoogleGenAI({ apiKey: 'test-key' });
    const host = client as unknown as LiveSocketHost;

    let socket: HandshakeWebSocket | undefined;
    host.live.webSocketFactory = {
      create: ((_url: string, _headers: Record<string, string>, callbacks: SocketCallbacks) => {
        socket = new HandshakeWebSocket(callbacks);
        return socket;
      }) as never,
    };

    if (options.fromHook) {
      expect(forwardHistoryConfigToSetup(host, options.fromHook)).toBe(true);
    }

    await client.live.connect({
      model: 'gemini-3.1-flash-live-preview',
      callbacks: { onmessage: () => {} },
      config: { historyConfig: options.onConnectConfig } as never,
    });

    return JSON.parse(socket!.sent[0]!).setup;
  }

  it('lands historyConfig on the setup frame the SDK builds', async () => {
    const setup = await connectAndCaptureSetup({
      fromHook: { initialHistoryInClientContent: true },
    });

    expect(setup.historyConfig).toEqual({ initialHistoryInClientContent: true });
    expect(setup.model).toBe('models/gemini-3.1-flash-live-preview');
  });

  it('is needed because the SDK drops historyConfig set on the connect config', async () => {
    const setup = await connectAndCaptureSetup({
      onConnectConfig: { initialHistoryInClientContent: true },
    });

    expect(setup.historyConfig).toBeUndefined();
  });
});

describe('historyConfigForSetup', () => {
  it('seeds history in client content for models that reject a model-role prefill', () => {
    expect(historyConfigForSetup({ mutableChatCtx: false })).toEqual({
      initialHistoryInClientContent: true,
    });
  });

  it('is unused when the model already accepts mid-session context updates', () => {
    expect(historyConfigForSetup({ mutableChatCtx: true })).toBeUndefined();
  });
});
