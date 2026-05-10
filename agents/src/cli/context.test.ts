// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it } from 'vitest';
import { ServerOptions } from '../worker.js';
import { clearDefaultAgentPath, getDefaultAgentPath, setDefaultAgentPath } from './context.js';
import { normalizeRunAppOptions } from './index.js';

describe('cli context', () => {
  afterEach(() => {
    clearDefaultAgentPath();
  });

  it('stores a default agent path for the current process', () => {
    setDefaultAgentPath('/app/dist/main.js');

    expect(getDefaultAgentPath()).toBe('/app/dist/main.js');
  });

  it('lets ServerOptions use the bootstrapped agent path when agent is omitted', () => {
    setDefaultAgentPath('/app/dist/main.js');

    const opts = new ServerOptions({ agentName: 'support-agent' });

    expect(opts.agent).toBe('/app/dist/main.js');
    expect(opts.agentName).toBe('support-agent');
  });

  it('prefers an explicit ServerOptions agent over the bootstrapped path', () => {
    setDefaultAgentPath('/app/dist/main.js');

    const opts = new ServerOptions({ agent: '/custom/agent.js' });

    expect(opts.agent).toBe('/custom/agent.js');
  });

  it('allows ServerOptions without an agent before the CLI command starts', () => {
    const opts = new ServerOptions({ agentName: 'support-agent' });

    expect(opts.agent).toBe('');
    expect(opts.agentName).toBe('support-agent');
  });

  it('normalizes plain runApp options using the bootstrapped agent path', () => {
    setDefaultAgentPath('/app/dist/main.js');

    const opts = normalizeRunAppOptions({ agentName: 'support-agent' });

    expect(opts).toBeInstanceOf(ServerOptions);
    expect(opts.agent).toBe('/app/dist/main.js');
    expect(opts.agentName).toBe('support-agent');
  });

  it('preserves existing ServerOptions passed to runApp', () => {
    const opts = new ServerOptions({ agent: '/custom/agent.js', agentName: 'support-agent' });

    expect(normalizeRunAppOptions(opts)).toBe(opts);
  });
});
