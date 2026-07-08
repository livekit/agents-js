// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Job, JobType, Room as RoomModel } from '@livekit/protocol';
import { Room } from '@livekit/rtc-node';
import { pathToFileURL } from 'node:url';
import { type Agent, isAgent } from './generator.js';
import type { InferenceExecutor } from './ipc/inference_executor.js';
import { InferenceProcExecutor } from './ipc/inference_proc_executor.js';
import { JobContext, JobProcess, type RunningJobInfo, runWithJobContextAsync } from './job.js';
import { log } from './log.js';
import { Future, shortuuid } from './utils.js';
import { AgentsConsole, TcpAudioInput, TcpAudioOutput } from './voice/console_io.js';
import { TcpSessionTransport } from './voice/remote_session.js';
import { defaultInitializeProcessFunc } from './worker.js';

const formatErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Fallback executor used when no local inference runners are registered.
 * Cloud inference models (`inference.LLM` & co.) connect to the gateway
 * directly and never touch this executor; only plugins that register an
 * {@link InferenceRunner} (e.g. the livekit turn detector) do, and those get a
 * real {@link InferenceProcExecutor} in {@link runConsole} instead.
 */
class ConsoleInferenceExecutor implements InferenceExecutor {
  async doInference(): Promise<unknown> {
    throw new Error('no inference runners registered; cannot run local inference');
  }
}

async function loadAgent(agentPath: string): Promise<Agent> {
  const module = await import(pathToFileURL(agentPath).href);
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
  agentName,
  wsURL,
  record,
}: {
  agentPath: string;
  connectAddr: string;
  agentName: string;
  wsURL: string;
  record: boolean;
}): Promise<void> {
  const logger = log();

  const sep = connectAddr.lastIndexOf(':');
  if (sep <= 0 || sep === connectAddr.length - 1) {
    throw new Error(`invalid --connect-addr "${connectAddr}", expected host:port`);
  }
  const host = connectAddr.slice(0, sep);
  const portStr = connectAddr.slice(sep + 1);
  const port = Number(portStr);
  if (!/^\d+$/.test(portStr) || port < 1 || port > 65535) {
    throw new Error(`invalid port in --connect-addr "${connectAddr}", expected 1-65535`);
  }

  const agent = await loadAgent(agentPath);
  const prewarm = agent.prewarm ?? defaultInitializeProcessFunc;

  const transport = new TcpSessionTransport(host, port, {
    serverInfo: {
      agentName,
      url: wsURL,
    },
  });
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
      enableRecording: record,
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

  logger.info({ host, port }, 'starting console session');

  let inferenceProc: InferenceProcExecutor | undefined;
  let ctx: JobContext | undefined;
  try {
    // Plugins that registered an InferenceRunner (e.g. the livekit turn
    // detector) run inference in a supervised child process, same as the
    // worker path. Without any runners the fallback executor just raises if
    // reached.
    let inferenceExecutor: InferenceExecutor = new ConsoleInferenceExecutor();
    inferenceProc = InferenceProcExecutor.createIfNeeded();
    if (inferenceProc) {
      try {
        await inferenceProc.start();
        await inferenceProc.initialize();
      } catch (error) {
        throw new Error(
          `the inference process failed to start (${formatErrorMessage(error)}); ` +
            'if your agent uses a plugin with local model files (e.g. the livekit ' +
            'turn detector), make sure they are downloaded: npx livekit-agents download-files',
        );
      }
      inferenceExecutor = inferenceProc;
    }

    const jobCtx = new JobContext(proc, info, room, () => {}, onShutdown, inferenceExecutor);
    ctx = jobCtx;
    await runWithJobContextAsync(jobCtx, async () => agent.entry(jobCtx));
    await shutdown.await;
  } finally {
    process.off('SIGINT', onShutdown);
    process.off('SIGTERM', onShutdown);

    // Guard every teardown step so one failure can't skip the rest — most
    // importantly the inference child shutdown at the end.
    const guarded = async (step: string, fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch (error) {
        logger.error({ error }, `error in ${step}`);
      }
    };

    const session = ctx?._primaryAgentSession;
    if (session) {
      await guarded('AgentSession.close', () => session.close());
    }
    const jobCtx = ctx;
    if (jobCtx) {
      await guarded('ctx._onSessionEnd', () => jobCtx._onSessionEnd());
    }
    await guarded('transport.close', () => transport.close());
    await guarded('room.disconnect', () => room.disconnect());

    if (jobCtx) {
      // Run job shutdown callbacks (e.g. AvatarSession.aclose) like the normal
      // worker path does; runConsole bypasses the ProcPool so it must drain them.
      const results = await Promise.allSettled(jobCtx.shutdownCallbacks.map((cb) => cb()));
      for (const result of results) {
        if (result.status === 'rejected') {
          logger.error({ error: result.reason }, 'error while running shutdown callback');
        }
      }
    }

    const proc_ = inferenceProc;
    if (proc_) {
      await guarded('inference process close', () => proc_.close());
    }
  }
}
