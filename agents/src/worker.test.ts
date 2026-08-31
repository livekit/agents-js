// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
import { AgentServer, ServerOptions } from './worker.js';

vi.mock('./inference/_warmup.js', () => ({
  _getLocalInferenceModule: () => undefined,
}));

describe('AgentServer connection failures', () => {
  it('run rejects when connection retries are exhausted', async () => {
    const server = new AgentServer(
      new ServerOptions({
        agent: 'test-agent.js',
        wsURL: 'ws://127.0.0.1:1',
        apiKey: 'devkey',
        apiSecret: 'devsecret',
        maxRetry: 0,
        numIdleProcesses: 0,
        simulation: true,
      }),
    );

    try {
      await expect(server.run()).rejects.toThrow(/failed to connect/);
    } finally {
      await server.close();
      await server.close();
    }
  });
});

describe('ServerOptions sessionEndTimeout', () => {
  it('defaults to five minutes', () => {
    const options = new ServerOptions({ agent: 'test-agent.js' });
    expect(options.sessionEndTimeout).toBe(300_000);
  });

  it('accepts an override', () => {
    const options = new ServerOptions({
      agent: 'test-agent.js',
      sessionEndTimeout: 12_345,
    });
    expect(options.sessionEndTimeout).toBe(12_345);
  });
});
