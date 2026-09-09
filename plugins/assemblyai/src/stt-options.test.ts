// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { ChatMessage } from '@livekit/agents';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { STT, type STTOptions, type SpeechStream } from './stt.js';

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1500;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for provider message');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function withProvider(
  opts: Partial<STTOptions>,
  check: (
    provider: STT,
    query: URLSearchParams,
    messages: Record<string, unknown>[],
    stream: SpeechStream,
  ) => Promise<void>,
): Promise<void> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(wss, 'listening');
  const address = wss.address() as AddressInfo;
  let query: URLSearchParams | undefined;
  const messages: Record<string, unknown>[] = [];
  wss.on('connection', (socket, request) => {
    query = new URL(request.url!, 'ws://localhost').searchParams;
    socket.on('message', (data, binary) => {
      if (!binary) messages.push(JSON.parse(data.toString()));
    });
  });
  const provider = new STT({
    apiKey: 'test-key',
    baseUrl: `ws://127.0.0.1:${address.port}`,
    ...opts,
  });
  const stream = provider.stream();
  try {
    await waitUntil(() => query !== undefined);
    await check(provider, query!, messages, stream);
  } finally {
    stream.close();
    for (const socket of wss.clients) socket.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  }
}

describe('AssemblyAI streaming configuration', () => {
  it('preserves omitted provider defaults', async () => {
    await withProvider({}, async (_provider, query) => {
      expect(query.has('continuous_partials')).toBe(false);
      expect(query.has('interruption_delay')).toBe(false);
    });
  });

  it('preserves explicit false and zero on connection', async () => {
    await withProvider({ continuousPartials: false, interruptionDelay: 0 }, async (_p, query) => {
      expect(query.get('continuous_partials')).toBe('false');
      expect(query.get('interruption_delay')).toBe('0');
    });
  });

  it('sends both partial controls in a live update', async () => {
    await withProvider({}, async (provider, _query, messages) => {
      provider.updateOptions({ continuousPartials: false, interruptionDelay: 0 });
      await waitUntil(() => messages.some((message) => message.type === 'UpdateConfiguration'));
      expect(messages.find((message) => message.type === 'UpdateConfiguration')).toEqual({
        type: 'UpdateConfiguration',
        continuous_partials: false,
        interruption_delay: 0,
      });
    });
  });

  it('normalizes names and clears language steering in a live update', async () => {
    await withProvider(
      { languageCodes: ['English', 'en-US', 'Spanish'] },
      async (p, q, messages) => {
        expect(JSON.parse(q.get('language_codes')!)).toEqual(['en', 'es']);
        p.updateOptions({ languageCodes: [] });
        await waitUntil(() => messages.some((message) => message.type === 'UpdateConfiguration'));
        expect(messages.find((message) => message.type === 'UpdateConfiguration')).toEqual({
          type: 'UpdateConfiguration',
          language_codes: [],
        });
      },
    );
  });

  it('enables carryover for the existing default model, with explicit opt-out', () => {
    expect(new STT({ apiKey: 'test' }).capabilities.chatContext).toBe(true);
    expect(new STT({ apiKey: 'test', agentContextCarryover: false }).capabilities.chatContext).toBe(
      false,
    );
  });
});

describe('AssemblyAI option validation', () => {
  it('does not clear the model when an update contains undefined', async () => {
    await withProvider({}, async (provider, _query, messages, stream) => {
      provider.updateOptions({ speechModel: undefined });
      stream.updateOptions({ speechModel: undefined });
      expect(provider.model).toBe('universal-3-5-pro');
      provider.updateOptions({ interruptionDelay: 0 });
      await waitUntil(() => messages.length > 0);
      expect(messages).toEqual([{ type: 'UpdateConfiguration', interruption_delay: 0 }]);
    });
  });

  for (const speechModel of [
    'universal-streaming-english',
    'universal-streaming-multilingual',
  ] as const) {
    for (const option of [{ continuousPartials: false }, { interruptionDelay: 0 }] as const) {
      it.each(['provider', 'stream'] as const)(
        `rejects ${Object.keys(option)[0]} on ${speechModel} via %s`,
        async (target) => {
          expect(() => new STT({ apiKey: 'test', speechModel, ...option })).toThrow(
            /only supported/,
          );
          await withProvider({ speechModel }, async (provider, _q, messages, stream) => {
            const updatable = target === 'provider' ? provider : stream;
            expect(() => updatable.updateOptions(option)).toThrow(/only supported/);
            updatable.updateOptions({ minTurnSilence: 250 });
            await waitUntil(() => messages.length > 0);
            expect(messages).toEqual([{ type: 'UpdateConfiguration', min_turn_silence: 250 }]);
          });
        },
      );
    }
  }

  it('rejects a combined model update before changing parent state or keyterms', async () => {
    await withProvider(
      { speechModel: 'universal-streaming-english', keytermsPrompt: ['original'] },
      async (provider, _q, messages) => {
        expect(() =>
          provider.updateOptions({
            speechModel: 'universal-3-6-pro',
            languageCodes: ['en'],
            keytermsPrompt: ['rejected'],
          }),
        ).toThrow(/create a new STT/);
        expect(provider.model).toBe('universal-streaming-english');
        provider._updateSessionKeyterms(['session']);
        await waitUntil(() => messages.length > 0);
        expect(messages).toEqual([
          { type: 'UpdateConfiguration', keyterms_prompt: ['original', 'session'] },
        ]);
      },
    );
  });

  it.each(['provider', 'stream'] as const)(
    'rejects model changes via %s without queuing Pro options',
    async (target) => {
      await withProvider(
        { speechModel: 'universal-streaming-english' },
        async (provider, _q, messages, stream) => {
          const updatable = target === 'provider' ? provider : stream;
          expect(() =>
            updatable.updateOptions({ speechModel: 'universal-3-6-pro', languageCodes: ['en'] }),
          ).toThrow(/create a new STT/);
          expect(() => updatable.updateOptions({ interruptionDelay: 0 })).toThrow(/only supported/);
          updatable.updateOptions({ minTurnSilence: 250 });
          await waitUntil(() => messages.length > 0);
          expect(messages).toEqual([{ type: 'UpdateConfiguration', min_turn_silence: 250 }]);
        },
      );
    },
  );

  it.each(['provider', 'stream'] as const)(
    'accepts the existing model alias via %s without mutating input',
    async (target) => {
      await withProvider(
        { speechModel: 'universal-3-5-pro' },
        async (provider, _q, messages, stream) => {
          const opts = Object.freeze({
            speechModel: 'u3-pro' as const,
            languageCodes: 'eng-US',
            interruptionDelay: 0,
          });
          (target === 'provider' ? provider : stream).updateOptions(opts);
          await waitUntil(() => messages.length > 0);
          expect(messages).toEqual([
            { type: 'UpdateConfiguration', language_codes: ['en'], interruption_delay: 0 },
          ]);
          expect(opts.languageCodes).toBe('eng-US');
          expect(opts.speechModel).toBe('u3-pro');
        },
      );
    },
  );

  it('normalizes regional ISO-639-3 codes on connection', async () => {
    await withProvider(
      { languageCodes: ['eng-US', 'spa-ES', 'cmn-Hans-CN', 'en'] },
      async (_provider, query) => {
        expect(JSON.parse(query.get('language_codes')!)).toEqual(['en', 'es', 'zh']);
      },
    );
  });

  it.each(['provider', 'stream'] as const)(
    'normalizes regional ISO-639-3 codes on %s updates',
    async (target) => {
      await withProvider({}, async (provider, _q, messages, stream) => {
        (target === 'provider' ? provider : stream).updateOptions({
          languageCodes: ['eng-US', 'spa-ES', 'cmn-Hans-CN', 'en'],
        });
        await waitUntil(() => messages.length > 0);
        expect(messages).toEqual([
          { type: 'UpdateConfiguration', language_codes: ['en', 'es', 'zh'] },
        ]);
      });
    },
  );

  it('accepts explicit context below the 1750-character provider limit', () => {
    const context = '😀'.repeat(900);
    expect(Array.from(context)).toHaveLength(900);
    expect(() => new STT({ apiKey: 'test', agentContext: context })).not.toThrow();
  });

  it('checks the Unicode code-point limit at construction', () => {
    expect(() => new STT({ apiKey: 'test', agentContext: '😀'.repeat(1750) })).not.toThrow();
    expect(() => new STT({ apiKey: 'test', agentContext: '😀'.repeat(1751) })).toThrow(/got 1751/);
  });

  it.each(['provider', 'stream'] as const)(
    'checks Unicode limits before changing %s configuration',
    async (target) => {
      await withProvider({}, async (provider, _q, messages, stream) => {
        const updatable = target === 'provider' ? provider : stream;
        expect(() => updatable.updateOptions({ agentContext: '😀'.repeat(1751) })).toThrow(
          /got 1751/,
        );
        const context = '😀'.repeat(1750);
        updatable.updateOptions({ agentContext: context });
        await waitUntil(() => messages.length > 0);
        expect(messages).toEqual([{ type: 'UpdateConfiguration', agent_context: context }]);
      });
    },
  );

  it('does not split a Unicode character when truncating carried-over text', async () => {
    await withProvider({}, async (provider, _query, messages) => {
      const reply = '😀'.repeat(900) + 'a';
      provider._pushConversationItem({
        type: 'conversation_item_added',
        createdAt: Date.now(),
        item: new ChatMessage({ role: 'assistant', content: reply }),
      });
      await waitUntil(() => messages.some((message) => message.type === 'UpdateConfiguration'));
      const context = messages.find(
        (message) => message.type === 'UpdateConfiguration',
      )?.agent_context;
      expect(context).toBe(reply);
    });
  });

  it('keeps the last 1750 Unicode code points of long carried-over text', async () => {
    await withProvider({}, async (provider, _query, messages) => {
      const reply = '😀'.repeat(1900) + 'a';
      provider._pushConversationItem({
        type: 'conversation_item_added',
        createdAt: Date.now(),
        item: new ChatMessage({ role: 'assistant', content: reply }),
      });
      await waitUntil(() => messages.length > 0);
      expect(messages).toEqual([
        { type: 'UpdateConfiguration', agent_context: '😀'.repeat(1749) + 'a' },
      ]);
    });
  });
});
