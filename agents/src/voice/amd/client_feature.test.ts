// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/** Ported from Python `tests/test_amd_client_feature.py`: AMD tags only its own Inference requests. */
import { once } from 'node:events';
import type { IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import * as inference from '../../inference/index.js';
import { CLIENT_FEATURE_HEADER } from '../../inference/utils.js';
import { ChatContext } from '../../llm/chat_context.js';
import { FallbackAdapter } from '../../llm/fallback_adapter.js';
import { initializeLogger } from '../../log.js';
import { DEFAULT_API_CONNECT_OPTIONS } from '../../types.js';
import { FakeLLM } from '../testing/fake_llm.js';
import { DrainingSTT, audioFrame } from './amd_test_utils.js';
import type { AMDRequest } from './chat_context.js';
import { AMDCategory } from './events.js';
import { classify, reachesOnlyInference } from './inference.js';
import { AMDTranscriber } from './stt.js';

initializeLogger({ pretty: false, level: 'silent' });

const chatCtx = ChatContext.empty();
chatCtx.addMessage({ role: 'user', content: 'hello?' });
const REQUEST: AMDRequest = {
  stage: AMDCategory.UNCERTAIN,
  recommendedNextCategories: Object.values(AMDCategory).sort(),
  previousPrediction: null,
  chatCtx,
  speechDuration: 500,
};

const RECORD_RESULT_CHUNKS = [
  {
    id: 'chatcmpl_test',
    choices: [
      {
        index: 0,
        delta: {
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: 'call_1',
              type: 'function',
              function: { name: 'record_result', arguments: '{"category":"human"}' },
            },
          ],
        },
        finish_reason: null,
      },
    ],
  },
  { id: 'chatcmpl_test', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
];

function inferenceLLM(): [inference.LLM, Record<string, string>[]] {
  const llm = new inference.LLM({
    model: 'google/gemma-4-31b-it',
    apiKey: 'test-key',
    apiSecret: 'test-secret',
    baseURL: 'https://example.livekit.cloud',
    modelOptions: { extra_headers: { 'X-Custom': 'kept' } } as Record<string, unknown>,
  });
  const requests: Record<string, string>[] = [];
  const stub = async (_body: unknown, options?: unknown) => {
    requests.push((options as { headers?: Record<string, string> } | undefined)?.headers ?? {});
    return {
      async *[Symbol.asyncIterator]() {
        yield* RECORD_RESULT_CHUNKS;
      },
    };
  };
  const internal = llm as unknown as {
    client: { chat: { completions: { create: typeof stub } } };
  };
  internal.client.chat.completions.create = stub;
  return [llm, requests];
}

describe('AMD client feature header', () => {
  it('tags the classifier request and not the next turn on the same LLM', async () => {
    const [llm, requests] = inferenceLLM();

    expect((await classify(llm, REQUEST)).category).toBe(AMDCategory.HUMAN);
    for await (const _ of llm.chat({ chatCtx })) {
      void _;
    }

    const [amd, agent] = requests;
    expect(requests).toHaveLength(2);
    expect(amd![CLIENT_FEATURE_HEADER]).toBe('AMD');
    expect(amd!['X-Custom']).toBe('kept');
    expect(agent![CLIENT_FEATURE_HEADER]).toBeUndefined();
    expect(agent!['X-Custom']).toBe('kept');
  });

  it('tags a FallbackAdapter only when every LLM is an Inference LLM', () => {
    const [gateway] = inferenceLLM();
    const plugin = new FakeLLM();

    expect(reachesOnlyInference(gateway)).toBe(true);
    expect(reachesOnlyInference(new FallbackAdapter({ llms: [gateway, gateway] }))).toBe(true);
    expect(reachesOnlyInference(new FallbackAdapter({ llms: [gateway, plugin] }))).toBe(false);
    expect(reachesOnlyInference(plugin)).toBe(false);
  });

  it('tags the AMD STT stream only for an Inference STT', async () => {
    const gateway = new inference.STT({
      model: 'cartesia/ink-whisper',
      apiKey: 'test-key',
      apiSecret: 'test-secret',
      baseURL: 'https://example.livekit.cloud',
    });
    const draining = new DrainingSTT();
    const gatewayStream = vi
      .spyOn(gateway, 'stream')
      .mockImplementation((options) => draining.stream(options) as never);
    const amd = new AMDTranscriber(gateway, DEFAULT_API_CONNECT_OPTIONS);
    amd.pushAudio(audioFrame());
    await amd.aclose();
    expect(gatewayStream.mock.calls[0]![0]!.extraHeaders).toEqual({
      [CLIENT_FEATURE_HEADER]: 'AMD',
    });

    const plugin = new DrainingSTT();
    const pluginStream = vi.spyOn(plugin, 'stream');
    const pluginAmd = new AMDTranscriber(plugin, DEFAULT_API_CONNECT_OPTIONS);
    pluginAmd.pushAudio(audioFrame());
    await pluginAmd.aclose();
    expect(pluginStream.mock.calls[0]![0]).not.toHaveProperty('extraHeaders');

    await draining.close();
    await plugin.close();
  });

  it('sends Inference STT extra headers below the SDK headers on connect', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const address = server.address() as AddressInfo;
    const upgrades: IncomingHttpHeaders[] = [];
    server.on('connection', (socket, req) => {
      upgrades.push(req.headers);
      socket.on('message', (raw) => {
        const event = JSON.parse(raw.toString()) as { type: string };
        if (event.type === 'session.finalize') {
          socket.send(JSON.stringify({ type: 'session.closed' }));
        }
      });
    });

    try {
      const stt = new inference.STT({
        model: 'cartesia/ink-whisper',
        apiKey: 'test-key',
        apiSecret: 'test-secret',
        baseURL: `http://127.0.0.1:${address.port}`,
        connOptions: { maxRetry: 0, retryIntervalMs: 1, timeoutMs: 1_000 },
      });
      const stream = stt.stream({
        extraHeaders: { [CLIENT_FEATURE_HEADER]: 'AMD', 'User-Agent': 'caller' },
      });
      try {
        stream.endInput();
        for await (const _ of stream) {
          void _;
        }
      } finally {
        stream.close();
      }

      const headers = upgrades[0]!;
      expect(headers[CLIENT_FEATURE_HEADER.toLowerCase()]).toBe('AMD');
      expect(headers['user-agent']).toMatch(/^livekit-agents-js\//);
      expect(headers.authorization).toMatch(/^Bearer /);
    } finally {
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
