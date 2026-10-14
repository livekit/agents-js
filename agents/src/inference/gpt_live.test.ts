// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { once } from 'node:events';
import type { IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import { DuplexRealtimeAdapter } from '../llm/duplex_adapter.js';
import type { ClientEvent, ErrorBody } from '../llm/openai_realtime/gpt_live_types.js';
import { RealtimeError } from '../llm/realtime.js';
import { ProviderTool, ToolContext } from '../llm/tool_context.js';
import { Agent } from '../voice/agent.js';
import { AgentSession } from '../voice/agent_session.js';
import { GPTLiveModel, type GPTLiveModelOptions, GPTLiveSession } from './gpt_live.js';
import * as inference from './index.js';
import { LLM, llmFromModelString } from './llm.js';
import { RealtimeModel } from './realtime.js';
import * as inferenceUtils from './utils.js';

const SECRET = 'secret-with-at-least-32-bytes-for-jwt';

class TestSession extends GPTLiveSession {
  fatal(error: ErrorBody): boolean {
    return this.isFatalError(error);
  }
}

class HostedSearch extends ProviderTool {
  constructor() {
    super({ id: 'hosted_search' });
  }
}

class Gateway {
  readonly server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  readonly requests: { url?: string; headers: IncomingHttpHeaders }[] = [];
  readonly starts: Extract<ClientEvent, { type: 'session.start' }>[] = [];

  constructor() {
    this.server.on('connection', (ws, req) => {
      this.requests.push({ url: req.url, headers: req.headers });
      ws.on('message', (data) => {
        const event = JSON.parse(data.toString()) as ClientEvent;
        if (event.type === 'session.start') {
          this.starts.push(event);
          ws.send(JSON.stringify({ type: 'session.started', session: { id: 'live_test' } }));
        } else if (event.type === 'session.close') {
          ws.send(JSON.stringify({ type: 'session.closed', usage: { seconds: 0 } }));
        }
      });
    });
  }

  get url(): string {
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/v1`;
  }

  stop(): Promise<void> {
    for (const client of this.server.clients) client.terminate();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

describe('inference GPTLiveModel', () => {
  let sessions: GPTLiveSession[];
  const model = (options: GPTLiveModelOptions = {}) =>
    new GPTLiveModel({ apiKey: 'lk-key', apiSecret: SECRET, ...options });
  const track = <T extends GPTLiveSession>(session: T): T => {
    session.on('error', () => {});
    sessions.push(session);
    return session;
  };

  beforeEach(() => {
    sessions = [];
    vi.stubEnv('LIVEKIT_API_KEY', 'lk-key');
    vi.stubEnv('LIVEKIT_API_SECRET', SECRET);
  });

  afterEach(async () => {
    await Promise.all(sessions.map((session) => session.close()));
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('is publicly exported with its canonical label', () => {
    const live = model();
    expect(inference.GPTLiveModel).toBe(GPTLiveModel);
    expect(live.label()).toBe('inference.GPTLiveModel');
    expect(live.provider).toBe('livekit');
    expect(live.model).toBe('openai/gpt-live-1');
  });

  it('connects to the gateway with ?model= and a LiveKit token signed per connection', async () => {
    const gateway = new Gateway();
    await once(gateway.server, 'listening');
    try {
      vi.spyOn(inferenceUtils, 'createAccessToken')
        .mockResolvedValueOnce('token-one')
        .mockResolvedValueOnce('token-two');
      const live = model({ baseURL: gateway.url, provider: 'openai' });
      const session = track(live.session());
      await session._updateSession();
      await vi.waitFor(() => expect(session.sessionId).toBe('live_test'));

      const request = gateway.requests[0]!;
      const url = new URL(request.url!, 'ws://gateway');
      expect(url.pathname).toBe('/v1/live/sessions');
      expect(url.searchParams.get('model')).toBe('openai/gpt-live-1');
      expect(request.headers.authorization).toBe('Bearer token-one');
      expect(request.headers['x-livekit-inference-provider']).toBe('openai');
      expect(request.headers).not.toHaveProperty('openai-service-tier');
      expect(gateway.starts[0]!.session.model).toBe('openai/gpt-live-1');
      expect(gateway.starts[0]!.session.delegation).toMatchObject({
        type: 'responses',
        responses: { model: 'gpt-5.6-luna' },
      });

      // a reconnect signs a fresh token rather than replaying one that may have expired
      await session.close();
      const next = track(live.session());
      await next._updateSession();
      await vi.waitFor(() => expect(gateway.requests).toHaveLength(2));
      expect(gateway.requests[1]!.headers.authorization).toBe('Bearer token-two');
    } finally {
      await Promise.all(sessions.map((session) => session.close()));
      await gateway.stop();
    }
  });

  it('refuses hosted tools the gateway cannot meter', async () => {
    const session = track(model().session());
    await expect(session._updateTools(new ToolContext([new HostedSearch()]))).rejects.toThrow(
      RealtimeError,
    );
  });

  it('accepts only the default delegation service tier', () => {
    expect(() => model({ responsesOptions: {} })).not.toThrow();
    expect(() => model({ responsesOptions: { serviceTier: 'default' } })).not.toThrow();
    expect(() => model({ responsesOptions: { serviceTier: 'priority' } })).toThrow(/default tier/);
  });

  it.each(['invalid_model', 'unsupported_server_tool', 'unsupported_delegated_model'])(
    'does not retry a session the gateway refused with %s',
    (code) => {
      const session = track(new TestSession(model()));
      expect(session.fatal({ type: 'invalid_request_error', code })).toBe(true);
      expect(session.fatal({ type: 'server_error', code: 'server_error' })).toBe(false);
    },
  );

  it('requires a provider-prefixed model', () => {
    expect(() => model({ model: 'gpt-live-1' })).toThrow(/provider-prefixed/);
  });

  it('is what the openai/gpt-live-1 model string resolves to', () => {
    expect(llmFromModelString('openai/gpt-live-1')).toBeInstanceOf(GPTLiveModel);
    expect(llmFromModelString('openai/gpt-5.6-luna')).toBeInstanceOf(LLM);

    const session = new AgentSession({ llm: 'openai/gpt-live-1' });
    expect(session.llm).toBeInstanceOf(DuplexRealtimeAdapter);
    const agent = new Agent({ instructions: '', llm: 'openai/gpt-live-1' });
    expect(agent.llm).toBeInstanceOf(DuplexRealtimeAdapter);
  });

  it('is not served by the realtime model class', () => {
    expect(
      () => new RealtimeModel({ model: 'openai/gpt-live-1', apiKey: 'lk-key', apiSecret: SECRET }),
    ).toThrow(/inference.GPTLiveModel/);
  });
});
