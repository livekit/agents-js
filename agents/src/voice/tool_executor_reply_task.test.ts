// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { beforeAll, describe, expect, it } from 'vitest';
import { ChatContext, FunctionCall, FunctionCallOutput } from '../llm/chat_context.js';
import { initializeLogger } from '../log.js';
import { Task } from '../utils.js';
import type { RunContext } from './run_context.js';
import { ToolExecutor } from './tool_executor.js';

beforeAll(() => {
  initializeLogger({ pretty: false, level: 'silent' });
});

/**
 * `enqueueReply` hands its reply task to `RunResult._watchHandle`, which
 * registers a done callback on it. A bare promise has none, so watching one
 * threw `TypeError: handle.addDoneCallback is not a function` — and because the
 * callback never registered, the run it belonged to never settled. The visible
 * symptom was `session.run()` hanging until the caller's timeout, with the
 * exception surfacing separately as an unhandled error.
 */
describe('ToolExecutor reply task', () => {
  const callPair = (): [FunctionCall, FunctionCallOutput] => [
    FunctionCall.create({ callId: 'call-1', name: 'tool', args: '{}' }),
    FunctionCallOutput.create({
      callId: 'call-1',
      name: 'tool',
      output: 'ok',
      isError: false,
    }),
  ];

  const executorWithStubbedAgent = () => {
    const agent = {
      chatCtx: ChatContext.empty(),
      updateChatCtx: async () => {},
    };

    return new ToolExecutor({
      owningActivity: { agent } as unknown as ConstructorParameters<
        typeof ToolExecutor
      >[0]['owningActivity'],
    });
  };

  it('hands _watchHandle something it can register a done callback on', async () => {
    const watched: unknown[] = [];
    const executor = executorWithStubbedAgent();

    const ctx = {
      session: {
        history: { insert: () => {} },
        _globalRunState: {
          _watchHandle: (handle: unknown) => {
            watched.push(handle);
          },
        },
      },
    } as unknown as RunContext<unknown>;

    await executor.enqueueReply(ctx, callPair());

    expect(watched).toHaveLength(1);
    // The contract `_watchHandle` actually relies on. Asserted structurally as
    // well as by type, because the regression arrived through a cast that made
    // the wrong thing typecheck.
    expect(watched[0]).toBeInstanceOf(Task);
    expect(typeof (watched[0] as { addDoneCallback?: unknown }).addDoneCallback).toBe('function');
  });

  it('settles the watched handle so a run driven by it can finish', async () => {
    let settled = false;
    const executor = executorWithStubbedAgent();

    const ctx = {
      session: {
        history: { insert: () => {} },
        _globalRunState: {
          _watchHandle: (handle: Task<void>) => {
            handle.addDoneCallback(() => {
              settled = true;
            });
          },
        },
      },
    } as unknown as RunContext<unknown>;

    await executor.enqueueReply(ctx, callPair());
    // The reply itself fails against this stub session and is swallowed by the
    // task's own catch — which is the point: the handle must reach `done`
    // whether the reply succeeded or not, or the run waits on it forever.
    await executor.waitForAll();

    expect(settled).toBe(true);
  });
});
