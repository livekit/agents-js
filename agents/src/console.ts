// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Job, JobType, Room as RoomModel } from '@livekit/protocol';
import { Room } from '@livekit/rtc-node';
import { pathToFileURL } from 'node:url';
import { type Agent, isAgent } from './generator.js';
import type { InferenceExecutor } from './ipc/inference_executor.js';
import { JobContext, JobProcess, type RunningJobInfo, runWithJobContextAsync } from './job.js';
import { log } from './log.js';
import { Future, shortuuid } from './utils.js';
import { AgentsConsole, TcpAudioInput, TcpAudioOutput } from './voice/console_io.js';
import { TcpSessionTransport } from './voice/remote_session.js';
import { defaultInitializeProcessFunc } from './worker.js';

/**
 * The LiveKit inference gateway runs in a child process for real jobs. The
 * in-process console runner has no such child, so gateway-backed models are
 * unsupported here — use a plugin model instead. Plugin models never touch this
 * executor, so a normal console agent works fine.
 */
class ConsoleInferenceExecutor implements InferenceExecutor {
  async doInference(): Promise<unknown> {
    throw new Error(
      'the LiveKit inference gateway is not available in console mode; use a plugin model instead',
    );
  }
}

async function loadAgent(agentPath: string): Promise<Agent> {
  const module = await import(pathToFileURL(agentPath).pathname);
  // ESM exposes the agent as `module.default`; CJS interop nests it once more.
  const agent =
    typeof module.default === 'function' || isAgent(module.default)
      ? module.default
      : module.default?.default;
  if (agent === undefined || !isAgent(agent)) {
    throw new Error(`Unable to load agent: missing or invalid default export in ${agentPath}`);
  }
  return agent;
}

/**
 * Run an agent in-process, attached to a local broker (e.g. the LiveKit CLI
 * `lk session` daemon) over a raw TCP socket. This is the JS analogue of
 * python's `_run_tcp_console`: it bypasses the websocket worker and ProcPool
 * entirely and drives the agent entrypoint on the current event loop so the
 * {@link AgentsConsole} singleton is shared with the agent's `AgentSession`.
 *
 * @experimental
 */
export async function runConsole({
  agentPath,
  connectAddr,
  record,
}: {
  agentPath: string;
  connectAddr: string;
  record: boolean;
}): Promise<void> {
  const logger = log();

  const sep = connectAddr.lastIndexOf(':');
  if (sep <= 0 || sep === connectAddr.length - 1) {
    throw new Error(`invalid --connect-addr "${connectAddr}", expected host:port`);
  }
  const host = connectAddr.slice(0, sep);
  const port = Number.parseInt(connectAddr.slice(sep + 1), 10);
  if (!Number.isInteger(port)) {
    throw new Error(`invalid port in --connect-addr "${connectAddr}"`);
  }

  const agent = await loadAgent(agentPath);
  const prewarm = agent.prewarm ?? defaultInitializeProcessFunc;

  const transport = new TcpSessionTransport(host, port);
  const audioInput = new TcpAudioInput();
  const audioOutput = new TcpAudioOutput(transport);

  const consoleInst = AgentsConsole.getInstance();
  consoleInst.enabled = true;
  consoleInst.record = record;
  consoleInst.transport = transport;
  consoleInst.audioInput = audioInput;
  consoleInst.audioOutput = audioOutput;

  const proc = new JobProcess();
  await prewarm(proc);

  const info: RunningJobInfo = {
    acceptArguments: { name: '', identity: 'console', metadata: '' },
    job: new Job({
      id: shortuuid('console-job-'),
      type: JobType.JT_ROOM,
      room: new RoomModel({ name: 'console-room' }),
    }),
    url: '',
    token: '',
    workerId: 'console',
    fakeJob: true,
  };

  const room = new Room();
  // `shutdown` resolves on a termination signal. The entrypoint typically
  // returns right after `session.start()`, so we then block on this future to
  // keep the session alive servicing broker requests until the process is
  // signalled (the broker owns the session lifetime). Mirrors python, whose
  // console blocks on `server.run()` until interrupted.
  const shutdown = new Future();
  const onShutdown = () => {
    if (!shutdown.done) shutdown.resolve();
  };
  process.once('SIGINT', onShutdown);
  process.once('SIGTERM', onShutdown);

  const ctx = new JobContext(
    proc,
    info,
    room,
    () => {},
    onShutdown,
    new ConsoleInferenceExecutor(),
  );

  logger.info({ host, port }, 'starting console session');

  try {
    await runWithJobContextAsync(ctx, async () => agent.entry(ctx));
    await shutdown.await;
  } finally {
    process.off('SIGINT', onShutdown);
    process.off('SIGTERM', onShutdown);
    if (ctx._primaryAgentSession) {
      await ctx._primaryAgentSession.close();
    }
    try {
      await ctx._onSessionEnd();
    } catch (error) {
      logger.error({ error }, 'error in ctx._onSessionEnd');
    }
    await transport.close();
    await room.disconnect();
  }
}
