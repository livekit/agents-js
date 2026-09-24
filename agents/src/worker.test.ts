// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { JobType, ServerMessage, WorkerMessage } from '@livekit/protocol';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import { AssignmentTimeoutError } from './_exceptions.js';
import { ProcPool } from './ipc/proc_pool.js';
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

// A fake LiveKit server: answers the worker's register, then drives one availability request.
async function startFakeServer(
  onWorkerMessage: (msg: WorkerMessage, reply: (m: ServerMessage) => void) => void,
) {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(wss, 'listening');
  wss.on('connection', (socket) => {
    const reply = (m: ServerMessage) => socket.send(m.toBinary());
    socket.on('message', (data) => {
      const msg = WorkerMessage.fromBinary(new Uint8Array(data as Buffer));
      // Like the real server, answer the worker's register before anything else.
      if (msg.message.case === 'register') {
        reply(
          new ServerMessage({
            message: {
              case: 'register',
              value: {
                workerId: 'W_test',
                serverInfo: { version: 'test', protocol: 1, region: 'test' },
              },
            },
          }),
        );
      }
      onWorkerMessage(msg, reply);
    });
  });
  const port = (wss.address() as AddressInfo).port;
  return {
    url: `ws://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of wss.clients) client.terminate();
        wss.close(() => resolve());
      }),
  };
}

const JOB_REQUEST = new ServerMessage({
  message: {
    case: 'availability',
    value: {
      job: { id: 'AJ_test', type: JobType.JT_ROOM, room: { name: 'room', sid: 'RM_test' } },
    },
  },
});

function availabilityAnswers(messages: WorkerMessage[]) {
  return messages
    .filter((m) => m.message.case === 'availability')
    .map((m) => (m.message.value as { available: boolean }).available);
}

describe('AgentServer job acceptance', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function runAcceptScenario(opts: { sendAssignment: boolean; waitMs: number }) {
    const received: WorkerMessage[] = [];
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);

    const fake = await startFakeServer((msg, reply) => {
      received.push(msg);
      if (msg.message.case === 'register') {
        reply(JOB_REQUEST);
      } else if (
        msg.message.case === 'availability' &&
        msg.message.value.available &&
        opts.sendAssignment
      ) {
        reply(
          new ServerMessage({
            message: {
              case: 'assignment',
              value: { job: { id: 'AJ_test' }, url: 'ws://127.0.0.1:1', token: 'token' },
            },
          }),
        );
      }
    });

    // Records how the user's accept() call settled; the default request function is `await req.accept()`.
    let acceptOutcome: 'pending' | 'resolved' | Error = 'pending';
    const server = new AgentServer(
      new ServerOptions({
        agent: 'test-agent.js',
        wsURL: fake.url,
        apiKey: 'devkey',
        apiSecret: 'devsecret',
        maxRetry: 0,
        numIdleProcesses: 0,
        simulation: true,
        requestFunc: async (req) => {
          try {
            await req.accept();
            acceptOutcome = 'resolved';
          } catch (error) {
            acceptOutcome = error as Error;
            // rethrow like the default request function (`await req.accept()`) does
            throw error;
          }
        },
      }),
    );
    const run = server.run().catch(() => undefined);
    try {
      await new Promise((resolve) => setTimeout(resolve, opts.waitMs));
      return { received, unhandled, acceptOutcome };
    } finally {
      await server.close();
      await fake.close();
      await run;
      process.off('unhandledRejection', onUnhandled);
    }
  }

  it('sends one availability answer when the assignment times out', async () => {
    // ASSIGNMENT_TIMEOUT is 7.5s; accept() now rejects with AssignmentTimeoutError instead of hanging,
    // and the request task must not answer a second time.
    const { received, unhandled, acceptOutcome } = await runAcceptScenario({
      sendAssignment: false,
      waitMs: 8_500,
    });

    expect(acceptOutcome).toBeInstanceOf(AssignmentTimeoutError);
    expect(availabilityAnswers(received)).toEqual([true]);
    expect(unhandled).toEqual([]);
  }, 20_000);

  it('sends one availability answer when the job fails to launch', async () => {
    const launchJob = vi
      .spyOn(ProcPool.prototype, 'launchJob')
      .mockRejectedValue(new Error('launch failed'));

    const { received, unhandled, acceptOutcome } = await runAcceptScenario({
      sendAssignment: true,
      waitMs: 500,
    });

    expect(launchJob).toHaveBeenCalledOnce();
    // accept() must not report success for a job that never launched
    expect(acceptOutcome).toBeInstanceOf(Error);
    expect((acceptOutcome as Error).message).toBe('launch failed');
    expect(availabilityAnswers(received)).toEqual([true]);
    expect(unhandled).toEqual([]);
  });
});
