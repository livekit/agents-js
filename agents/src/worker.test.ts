// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { AgentServer, ServerOptions } from './worker.js';

describe('AgentServer options validation', () => {
  it('throws a clear error when no agent path is available at server start', () => {
    const opts = new ServerOptions({
      wsURL: 'ws://localhost:7880',
      apiKey: 'key',
      apiSecret: 'secret',
    });

    expect(() => new AgentServer(opts)).toThrow(
      'No Agent file was passed to the worker. Pass `agent` in ServerOptions or run via `lk-agent <entry> <command>`.',
    );
  });
});
