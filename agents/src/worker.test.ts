// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentServer, ServerOptions, deploymentFromEnv } from './worker.js';

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

  it.each([-1, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NaN])(
    'rejects invalid value %s',
    (sessionEndTimeout) => {
      expect(() => new ServerOptions({ agent: 'test-agent.js', sessionEndTimeout })).toThrow(
        'sessionEndTimeout must be a finite, non-negative number',
      );
    },
  );

  it('rejects values above the Node.js timer limit', () => {
    expect(
      () => new ServerOptions({ agent: 'test-agent.js', sessionEndTimeout: 2_147_483_648 }),
    ).toThrow('sessionEndTimeout must not exceed 2147483647 milliseconds');
  });
});

describe('ServerOptions agentName from livekit.toml', () => {
  const originalCwd = process.cwd();
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lk-toml-'));
    process.chdir(dir);
    vi.stubEnv('LIVEKIT_AGENT_NAME', '');
    vi.stubEnv('LIVEKIT_AGENT_NAME_OVERRIDE', '');
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(dir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it('reads [agent] name in production when nothing else sets it', () => {
    writeFileSync('livekit.toml', '[agent]\nname = "toml-agent"\n');
    const options = new ServerOptions({ agent: 'test-agent.js', production: true });
    expect(options.agentName).toBe('toml-agent');
    expect(options.agentNameIsEnv).toBe(true);
  });

  it('prefers LIVEKIT_AGENT_NAME over the toml name', () => {
    writeFileSync('livekit.toml', '[agent]\nname = "toml-agent"\n');
    vi.stubEnv('LIVEKIT_AGENT_NAME', 'env-agent');
    const options = new ServerOptions({ agent: 'test-agent.js', production: true });
    expect(options.agentName).toBe('env-agent');
  });

  it('ignores the toml name outside production', () => {
    writeFileSync('livekit.toml', '[agent]\nname = "toml-agent"\n');
    const options = new ServerOptions({ agent: 'test-agent.js', production: false });
    expect(options.agentName).toBe('');
    expect(options.agentNameIsEnv).toBe(false);
  });

  it('survives the cli.ts re-construction that spreads dev-mode options', () => {
    writeFileSync('livekit.toml', '[agent]\nname = "toml-agent"\n');
    const { production: _, ...dev } = new ServerOptions({ agent: 'test-agent.js' }); // eslint-disable-line @typescript-eslint/no-unused-vars
    const options = new ServerOptions({ ...dev, production: true });
    expect(options.agentName).toBe('toml-agent');
    expect(options.agentNameIsEnv).toBe(true);
  });

  it('is empty without a livekit.toml or with a malformed one', () => {
    expect(new ServerOptions({ agent: 'test-agent.js', production: true }).agentName).toBe('');
    writeFileSync('livekit.toml', '[agent\nname = ');
    expect(new ServerOptions({ agent: 'test-agent.js', production: true }).agentName).toBe('');
  });
});

describe('deploymentFromEnv', () => {
  it('reads LIVEKIT_AGENT_DEPLOYMENT', () => {
    expect(deploymentFromEnv({ LIVEKIT_AGENT_DEPLOYMENT: 'dev-1234' })).toBe('dev-1234');
  });

  it('treats production as the default deployment', () => {
    expect(deploymentFromEnv({ LIVEKIT_AGENT_DEPLOYMENT: 'production' })).toBe('');
  });

  it('defaults to empty when unset', () => {
    expect(deploymentFromEnv({})).toBe('');
  });
});
