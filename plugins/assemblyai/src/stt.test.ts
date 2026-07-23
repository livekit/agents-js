// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  AgentHandoffItem,
  ChatMessage,
  createConversationItemAddedEvent,
  log,
} from '@livekit/agents';
import { VAD } from '@livekit/agents-plugin-silero';
import { stt } from '@livekit/agents-plugins-test';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import { STT } from './stt.js';

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

describe('AssemblyAI options', () => {
  it('accepts u3-rt-pro-beta-1', () => {
    const stt = new STT({ apiKey: 'test-key', speechModel: 'u3-rt-pro-beta-1' });

    expect(stt.model).toBe('u3-rt-pro-beta-1');
  });

  it('accepts u3-pro parameters for u3-rt-pro-beta-1', () => {
    expect(
      () =>
        new STT({
          apiKey: 'test-key',
          speechModel: 'u3-rt-pro-beta-1',
          prompt: 'medical dictation',
          agentContext: "The agent asked for the patient's name.",
          previousContextNTurns: 10,
        }),
    ).not.toThrow();
  });

  it('requires a u3-rt-pro model for agentContext', () => {
    expect(
      () =>
        new STT({
          apiKey: 'test-key',
          speechModel: 'universal-streaming-english',
          agentContext: 'hello',
        }),
    ).toThrow(/agentContext/);
  });

  it('rejects agentContext values longer than 1750 characters', () => {
    expect(
      () =>
        new STT({
          apiKey: 'test-key',
          agentContext: 'x'.repeat(1751),
        }),
    ).toThrow(/1750/);
  });

  it('preserves agentContext when an update fails validation', async () => {
    const { wss, baseUrl } = await startWebSocketServer();
    let requestUrl = '';
    wss.on('connection', (_ws, req) => {
      requestUrl = req.url ?? '';
    });

    try {
      const stt = new STT({
        apiKey: 'test-key',
        baseUrl,
        agentContext: 'original context',
      });

      expect(() => stt.updateOptions({ agentContext: 'x'.repeat(1751) })).toThrow(/1750/);

      const stream = stt.stream();
      await waitUntil(() => requestUrl !== '');
      stream.close();

      const url = new URL(`ws://127.0.0.1${requestUrl}`);
      expect(url.searchParams.get('agent_context')).toBe('original context');
    } finally {
      await closeWebSocketServer(wss);
    }
  });

  it('rejects oversized agentContext updates on an active stream', async () => {
    const { wss, baseUrl } = await startWebSocketServer();
    let connected = false;
    wss.on('connection', () => {
      connected = true;
    });

    try {
      const stream = new STT({ apiKey: 'test-key', baseUrl }).stream();
      await waitUntil(() => connected);

      expect(() => stream.updateOptions({ agentContext: 'x'.repeat(1751) })).toThrow(/1750/);
      stream.close();
    } finally {
      await closeWebSocketServer(wss);
    }
  });

  it('requires a u3-rt-pro model for previousContextNTurns', () => {
    expect(
      () =>
        new STT({
          apiKey: 'test-key',
          speechModel: 'universal-streaming-english',
          previousContextNTurns: 5,
        }),
    ).toThrow(/previousContextNTurns/);
  });

  it('carryover is on by default for U3 Pro family', () => {
    for (const speechModel of [
      'u3-rt-pro',
      'u3-rt-pro-beta-1',
      'universal-3-5-pro',
      'u3-pro',
    ] as const) {
      const stt = new STT({ apiKey: 'test-key', speechModel });
      expect(stt.capabilities.chatContext).toBe(true);
    }
  });

  it('carryover default does not warn', () => {
    const warn = vi.spyOn(log(), 'warn');

    const stt = new STT({ apiKey: 'test-key', speechModel: 'universal-3-5-pro' });

    expect(stt.capabilities.chatContext).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('deprecated agentContextCarryover true still enables and warns', () => {
    const warn = vi.spyOn(log(), 'warn');

    const stt = new STT({
      apiKey: 'test-key',
      speechModel: 'universal-3-5-pro',
      agentContextCarryover: true,
    });

    expect(stt.capabilities.chatContext).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('deprecated'));
    warn.mockRestore();
  });

  it('carryover defaults off for unsupported models without warning', () => {
    const warn = vi.spyOn(log(), 'warn');

    const stt = new STT({ apiKey: 'test-key', speechModel: 'universal-streaming-english' });

    expect(stt.capabilities.chatContext).toBe(false);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('deprecated agentContextCarryover true on unsupported model warns and is ignored', () => {
    const warn = vi.spyOn(log(), 'warn');

    const stt = new STT({
      apiKey: 'test-key',
      speechModel: 'universal-streaming-english',
      agentContextCarryover: true,
    });

    expect(stt.capabilities.chatContext).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('deprecated'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('does not support it'));
    warn.mockRestore();
  });

  it('deprecated agentContextCarryover false disables and warns', () => {
    const warn = vi.spyOn(log(), 'warn');

    const stt = new STT({ apiKey: 'test-key', agentContextCarryover: false });

    expect(stt.capabilities.chatContext).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('deprecated'));
    warn.mockRestore();
  });

  it('deprecated agentContextCarryover true wins over previousContextNTurns zero', () => {
    const warn = vi.spyOn(log(), 'warn');

    const stt = new STT({
      apiKey: 'test-key',
      previousContextNTurns: 0,
      agentContextCarryover: true,
    });

    expect(stt.capabilities.chatContext).toBe(true);
    warn.mockRestore();
  });

  it('forwards short assistant replies as agent context', () => {
    const stt = new STT({ apiKey: 'test-key' });
    const update = vi.spyOn(stt, 'updateOptions');

    stt._pushConversationItem(
      createConversationItemAddedEvent(
        ChatMessage.create({ role: 'assistant', content: ['Your order is ready.'] }),
      ),
    );

    expect(update).toHaveBeenCalledWith({ agentContext: 'Your order is ready.' });
  });

  it('truncates automatic assistant context to the final 1750 characters', () => {
    const stt = new STT({ apiKey: 'test-key' });
    const update = vi.spyOn(stt, 'updateOptions');
    const reply = `${'a'.repeat(500)}${'b'.repeat(1750)}`;

    stt._pushConversationItem(
      createConversationItemAddedEvent(ChatMessage.create({ role: 'assistant', content: [reply] })),
    );

    expect(update).toHaveBeenCalledWith({ agentContext: 'b'.repeat(1750) });
  });

  it('ignores non-assistant messages and non-message items', () => {
    const stt = new STT({ apiKey: 'test-key' });
    const update = vi.spyOn(stt, 'updateOptions');

    stt._pushConversationItem(
      createConversationItemAddedEvent(ChatMessage.create({ role: 'user', content: ['hello'] })),
    );
    stt._pushConversationItem(
      createConversationItemAddedEvent(AgentHandoffItem.create({ newAgentId: 'agent-2' })),
    );

    expect(update).not.toHaveBeenCalled();
  });

  it('forwards inactivity timeout to the streaming query', async () => {
    const { wss, baseUrl } = await startWebSocketServer();
    let requestUrl = '';

    wss.on('connection', (_ws, req) => {
      requestUrl = req.url ?? '';
    });

    try {
      const stream = new STT({
        apiKey: 'test-key',
        baseUrl,
        inactivityTimeout: 45,
      }).stream();

      await waitUntil(() => requestUrl !== '');
      stream.close();

      const url = new URL(`ws://127.0.0.1${requestUrl}`);
      expect(url.pathname).toBe('/v3/ws');
      expect(url.searchParams.get('inactivity_timeout')).toBe('45');
    } finally {
      await closeWebSocketServer(wss);
    }
  });
});

const hasAssemblyAIApiKey = Boolean(process.env.ASSEMBLYAI_API_KEY);

if (hasAssemblyAIApiKey) {
  describe('AssemblyAI', async () => {
    await stt(new STT(), await VAD.load(), { nonStreaming: false });
  });
} else {
  describe('AssemblyAI', () => {
    it.skip('requires ASSEMBLYAI_API_KEY', () => {});
  });
}
