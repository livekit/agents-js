// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Job, JobType, ServerMessage, WorkerMessage } from '@livekit/protocol';
import { once } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import type { JobRequest } from './job.js';
import { AgentServer, ServerOptions } from './worker.js';

const mocks = vi.hoisted(() => ({
  launchJob: vi.fn(async (_args: unknown) => {}),
}));

vi.mock('./inference/_warmup.js', () => ({
  _getLocalInferenceModule: () => undefined,
}));
vi.mock('./ipc/proc_pool.js', () => ({
  ProcPool: class {
    processes = [];
    start() {}
    async close() {}
    launchJob(args: unknown) {
      return mocks.launchJob(args);
    }
  },
}));

type AvailabilityReply = { jobId: string; available: boolean };

async function startHarness(jobId: string, requestFunc: (request: JobRequest) => Promise<void>) {
  const socketServer = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(socketServer, 'listening');
  const addr = socketServer.address();
  if (addr === null || typeof addr === 'string') throw new Error('Expected TCP address');

  const job = new Job({ id: jobId, type: JobType.JT_ROOM });
  const responses: AvailabilityReply[] = [];
  let serverSocket: WebSocket | undefined;
  socketServer.on('connection', (socket) => {
    serverSocket = socket;
    socket.on('message', (data: Buffer) => {
      const message = new WorkerMessage();
      message.fromBinary(new Uint8Array(data));
      if (message.message.case === 'register') {
        socket.send(
          new ServerMessage({
            message: { case: 'register', value: { workerId: 'test-worker' } },
          }).toBinary(),
        );
        setImmediate(() => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(
              new ServerMessage({
                message: { case: 'availability', value: { job } },
              }).toBinary(),
            );
          }
        });
      } else if (message.message.case === 'availability') {
        responses.push({
          jobId: message.message.value.jobId,
          available: message.message.value.available,
        });
      }
    });
  });

  const worker = new AgentServer(
    new ServerOptions({
      agent: 'test-agent.js',
      requestFunc,
      wsURL: `ws://127.0.0.1:${addr.port}/`,
      apiKey: 'testkey',
      apiSecret: 'testsecret',
      maxRetry: 0,
      numIdleProcesses: 0,
      loadFunc: async () => 0,
      simulation: true,
    }),
  );
  const running = worker.run();
  void running.catch(() => {});
  return {
    responses,
    sendAssignment() {
      if (!serverSocket || serverSocket.readyState !== WebSocket.OPEN) {
        throw new Error('Server WebSocket is closed');
      }
      serverSocket.send(
        new ServerMessage({
          message: { case: 'assignment', value: { job, token: 'test-token' } },
        }).toBinary(),
      );
    },
    async close() {
      try {
        await worker.close();
        await running;
      } finally {
        await new Promise<void>((resolve, reject) =>
          socketServer.close((error) => (error ? reject(error) : resolve())),
        );
      }
    },
  };
}

describe('AgentServer availability response is sent once', () => {
  beforeEach(() => mocks.launchJob.mockClear());

  it('preserves normal accepted requests', async () => {
    const harness = await startHarness('normal', async (request) => {
      await request.accept();
    });
    try {
      await vi.waitFor(() => expect(harness.responses).toHaveLength(1), { timeout: 2_000 });
      expect(harness.responses).toEqual([{ jobId: 'normal', available: true }]);
      harness.sendAssignment();
      await vi.waitFor(() => expect(mocks.launchJob).toHaveBeenCalledTimes(1), {
        timeout: 2_000,
      });
    } finally {
      await harness.close();
    }
  }, 10_000);

  it('explicitly rejects when a request handler returns without responding', async () => {
    const harness = await startHarness('no-answer', async () => {});
    try {
      await vi.waitFor(() => expect(harness.responses).toHaveLength(1), { timeout: 2_000 });
      expect(harness.responses).toEqual([{ jobId: 'no-answer', available: false }]);
    } finally {
      await harness.close();
    }
  }, 10_000);

  it('does not reject a request that was accepted before its handler threw', async () => {
    const harness = await startHarness('accept-then-throw', async (request) => {
      await request.accept();
      throw new Error('application error after acceptance');
    });
    try {
      await vi.waitFor(() => expect(harness.responses.length).toBeGreaterThanOrEqual(1), {
        timeout: 2_000,
      });
      harness.sendAssignment(); // Release the accepted job's pending assignment.
      await vi.waitFor(() => expect(mocks.launchJob).toHaveBeenCalledTimes(1), {
        timeout: 2_000,
      });
      // Give the rejected-request path time to emit any contradictory message.
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(harness.responses).toEqual([{ jobId: 'accept-then-throw', available: true }]);
    } finally {
      await harness.close();
    }
  }, 10_000);

  it('does not accept a request that was already rejected', async () => {
    const harness = await startHarness('reject-then-accept', async (request) => {
      await request.reject();
      await request.accept();
    });
    try {
      await vi.waitFor(() => expect(harness.responses.length).toBeGreaterThanOrEqual(1), {
        timeout: 2_000,
      });
      await new Promise((resolve) => setTimeout(resolve, 80));
      // Clear a pending assignment in the original buggy implementation,
      // avoiding a 7.5-second timeout while demonstrating the failure.
      if (harness.responses.some((response) => response.available)) harness.sendAssignment();
      expect(harness.responses).toEqual([{ jobId: 'reject-then-accept', available: false }]);
    } finally {
      await harness.close();
    }
  }, 10_000);
});
