// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { expect, it, onTestFinished, vi } from 'vitest';
import { FunctionCall } from '../llm/chat_context.js';
import { ToolError, handoff, tool } from '../llm/tool_context.js';
import { Future } from '../utils.js';
import { Agent, AgentTask } from './agent.js';
import { AgentSession } from './agent_session.js';
import { FakeLLM } from './testing/fake_llm.js';

const transitionError =
  'An agent transition is in progress, so this tool call cannot continue. ' +
  'Wait until the transition is complete before retrying, if the tool is ' +
  'available to the new agent.';

// The two turns must not reuse FakeLLM's default call ID while a tool is still running.
class UniqueCallLLM extends FakeLLM {
  private generation = 0;

  override chat(options: Parameters<FakeLLM['chat']>[0]) {
    const stream = super.chat(options);
    const generation = ++this.generation;
    const next = stream.next.bind(stream);
    stream.next = async () => {
      const result = await next();
      if (!result.done && result.value.delta?.toolCalls) {
        result.value.delta.toolCalls = result.value.delta.toolCalls.map((call) =>
          FunctionCall.create({ ...call, callId: `${generation}_${call.callId}` }),
        );
      }
      return result;
    };
    return stream;
  }
}

function createFixture(toolErrorGate?: Future<void>) {
  const admission = new Future<void>();
  const started = new Future<void>();
  const result = new Future<unknown>();
  const exiting = new Future<void>();
  const finishExit = new Future<void>();
  const switchStarted = new Future<void>();
  const finishSwitch = new Future<void>();
  const taskEntered = vi.fn();
  const targetEntered = vi.fn();
  const target = Agent.create({ instructions: 'target', onEnter: targetEntered });
  const task = AgentTask.create<string>({
    instructions: 'complete immediately',
    onEnter: () => {
      taskEntered();
      task.complete('done');
    },
  });
  const agent = Agent.create({
    instructions: 'source',
    onExit: async () => {
      exiting.resolve();
      await finishExit.await;
    },
    tools: [
      tool({
        name: 'transfer',
        description: 'Run an inline task after admission.',
        execute: async (_args, { ctx }) => {
          ctx.speechHandle.allowInterruptions = false;
          started.resolve();
          await admission.await;
          try {
            const value = await task.run();
            result.resolve(value);
            return value;
          } catch (error) {
            result.resolve(error);
            if (toolErrorGate) await toolErrorGate.await;
            throw error;
          }
        },
      }),
      tool({
        name: 'switch',
        description: 'Hand off to the target.',
        execute: async () => {
          switchStarted.resolve();
          await finishSwitch.await;
          return handoff({ agent: target });
        },
      }),
    ],
  });
  const llm = new UniqueCallLLM([
    { input: 'transfer', toolCalls: [{ name: 'transfer', args: {} }] },
    { input: 'switch', toolCalls: [{ name: 'switch', args: {} }] },
  ]);
  const session = new AgentSession({ llm, turnHandling: { turnDetection: 'manual' } });
  onTestFinished(async () => {
    admission.resolve();
    finishExit.resolve();
    toolErrorGate?.resolve();
    finishSwitch.resolve();
    await session.close();
    expect(agent._agentActivity).toBeUndefined();
    expect(task._agentActivity).toBeUndefined();
    expect(target._agentActivity).toBeUndefined();
  });
  return {
    session,
    agent,
    target,
    taskEntered,
    targetEntered,
    llm,
    admission,
    started,
    result,
    exiting,
    finishExit,
    switchStarted,
    finishSwitch,
  };
}

type Fixture = ReturnType<typeof createFixture>;

async function startPendingTool(f: Fixture) {
  await f.session.start({ agent: f.agent });
  void f.session.generateReply({ userInput: 'transfer', allowInterruptions: false });
  await f.started.await;
  await vi.waitFor(() => expect(f.agent._agentActivity!.currentSpeech).toBeUndefined());
}

async function expectRejected(f: Fixture) {
  expect(await f.result.await).toBeInstanceOf(ToolError);
  expect(await f.result.await).toHaveProperty('message', transitionError);
  expect(f.taskEntered).not.toHaveBeenCalled();
}

async function expectHandoff(f: Fixture) {
  await vi.waitFor(() => expect(f.targetEntered).toHaveBeenCalledOnce());
  expect(f.session.currentAgent).toBe(f.target);
  await f.session.close();
  const calls = f.agent.chatCtx.items.filter(
    (item) => item.type === 'function_call' && item.name === 'transfer',
  );
  expect(calls).toHaveLength(1);
  const outputs = f.agent.chatCtx.items.filter(
    (item) => item.type === 'function_call_output' && item.callId === calls[0]!.callId,
  );
  expect(outputs).toHaveLength(1);
  expect(outputs[0]).toMatchObject({ isError: true, output: transitionError });
}

it('completes an inline task before handoff', async () => {
  const f = createFixture();
  await startPendingTool(f);
  f.admission.resolve();
  expect(await f.result.await).toBe('done');
  expect(f.taskEntered).toHaveBeenCalledOnce();
  f.finishSwitch.resolve();
  f.finishExit.resolve();
  void f.session.generateReply({ userInput: 'switch' });
  await vi.waitFor(() => expect(f.targetEntered).toHaveBeenCalledOnce());
  expect(f.session.currentAgent).toBe(f.target);
});

it('rejects an inline task while handoff waits for the transition lock', async () => {
  const f = createFixture();
  await startPendingTool(f);
  const unlock = await f.session['activityLock'].lock();
  try {
    f.session.updateAgent(f.target);
    f.admission.resolve();
    await expectRejected(f);
    expect(f.exiting.done).toBe(false);
    expect(f.agent._agentActivity!.schedulingPaused).toBe(false);
  } finally {
    unlock();
  }
  f.finishExit.resolve();
  await expectHandoff(f);
});

it('rejects an inline task during a direct activity transition', async () => {
  const f = createFixture();
  await startPendingTool(f);
  const transition = f.session._updateActivity(f.target, { waitOnEnter: false });
  try {
    await f.exiting.await;
    expect(f.agent._agentActivity!.schedulingPaused).toBe(false);
    f.admission.resolve();
    await expectRejected(f);
  } finally {
    f.admission.resolve();
    f.finishExit.resolve();
    await transition;
  }
  await expectHandoff(f);
});

it('rejects a tool that starts after handoff drain has begun', async () => {
  const f = createFixture();
  const generationStarted = new Future<void>();
  const emitTool = new Future<void>();
  const chat = f.llm.chat.bind(f.llm);
  const chatSpy = vi.spyOn(f.llm, 'chat').mockImplementation((options) => {
    const stream = chat(options);
    const next = stream.next.bind(stream);
    stream.next = async () => {
      const chunk = await next();
      if (!chunk.done && chunk.value.delta?.toolCalls?.some((call) => call.name === 'transfer')) {
        generationStarted.resolve();
        await emitTool.await;
      }
      return chunk;
    };
    return stream;
  });
  try {
    await f.session.start({ agent: f.agent });
    void f.session.generateReply({ userInput: 'switch' });
    await f.switchStarted.await;
    await vi.waitFor(() => expect(f.agent._agentActivity!.currentSpeech).toBeUndefined());
    void f.session.generateReply({ userInput: 'transfer', allowInterruptions: false });
    await generationStarted.await;
    f.finishSwitch.resolve();
    f.finishExit.resolve();
    await vi.waitFor(() => expect(f.agent._agentActivity!.schedulingPaused).toBe(true));
    expect(f.started.done).toBe(false);
    emitTool.resolve();
    await f.started.await;
    f.admission.resolve();
    await expectRejected(f);
    await expectHandoff(f);
  } finally {
    emitTool.resolve();
    chatSpy.mockRestore();
  }
});

it.each([false, true])(
  'rejects an inline task during handoff onExit (shutdown=%s)',
  async (shutdown) => {
    const finishTool = new Future<void>();
    const f = createFixture(shutdown ? finishTool : undefined);
    await startPendingTool(f);
    f.finishSwitch.resolve();
    void f.session.generateReply({ userInput: 'switch' });
    await f.exiting.await;
    expect(f.agent._agentActivity!.schedulingPaused).toBe(false);
    f.admission.resolve();
    await expectRejected(f);
    const closing = shutdown ? f.session.close() : undefined;
    finishTool.resolve();
    f.finishExit.resolve();
    if (closing) {
      await closing;
      expect(f.targetEntered).not.toHaveBeenCalled();
    } else {
      await expectHandoff(f);
    }
  },
);

it.each([false, true])(
  'rejects an inline task during handoff drain (shutdown=%s)',
  async (shutdown) => {
    const finishTool = new Future<void>();
    const f = createFixture(shutdown ? finishTool : undefined);
    await startPendingTool(f);
    f.finishSwitch.resolve();
    f.finishExit.resolve();
    void f.session.generateReply({ userInput: 'switch' });
    await vi.waitFor(() => expect(f.agent._agentActivity!.schedulingPaused).toBe(true));
    f.admission.resolve();
    await expectRejected(f);
    const closing = shutdown ? f.session.close() : undefined;
    finishTool.resolve();
    if (closing) {
      await closing;
      expect(f.targetEntered).not.toHaveBeenCalled();
    } else {
      await expectHandoff(f);
    }
  },
);

it.each([false, true])(
  'rejects an inline task on a queued intermediate agent (shutdown=%s)',
  async (shutdown) => {
    const finishTool = new Future<void>();
    const f = createFixture(shutdown ? finishTool : undefined);
    const root = Agent.create({ instructions: 'root' });
    const enter = vi.spyOn(f.agent, 'onEnter').mockImplementation(async () => {
      void f.session.generateReply({ userInput: 'transfer' });
    });
    try {
      await f.session.start({ agent: root });
      // Both requests initially block root, not the intermediate source activity.
      f.session.updateAgent(f.agent);
      f.session.updateAgent(f.target);
      await f.started.await;
      await vi.waitFor(() => expect(f.agent._agentActivity!.currentSpeech).toBeUndefined());
      await f.exiting.await;
      expect(f.agent._agentActivity!.schedulingPaused).toBe(false);
      f.admission.resolve();
      await expectRejected(f);
      const closing = shutdown ? f.session.close() : undefined;
      finishTool.resolve();
      f.finishExit.resolve();
      if (closing) {
        await closing;
        expect(f.targetEntered).not.toHaveBeenCalled();
      } else {
        await expectHandoff(f);
      }
      expect(root._agentActivity).toBeUndefined();
    } finally {
      enter.mockRestore();
    }
  },
);

it.each([false, true])(
  'allows an in-flight tool to await an AgentTask during standalone drain (generationPending=%s)',
  async (generationPending) => {
    const started = new Future<void>();
    const releaseTool = new Future<void>();
    const releaseGeneration = new Future<void>();
    const completed = new Future<unknown>();
    let drained = false;
    let draining: Promise<unknown> | undefined;
    const task = AgentTask.create<string>({
      instructions: 'complete immediately',
      onEnter: () => {
        expect(drained).toBe(true);
        task.complete('done');
      },
    });
    const agent = Agent.create({
      instructions: 'source',
      tools: [
        tool({
          name: 'transfer',
          description: 'Run an inline task.',
          execute: async (_args, { ctx }) => {
            ctx.speechHandle.allowInterruptions = false;
            started.resolve();
            await releaseTool.await;
            try {
              const value = await task.run();
              completed.resolve(value);
              return value;
            } catch (error) {
              completed.resolve(error);
              throw error;
            }
          },
        }),
      ],
    });
    const llm = new UniqueCallLLM([
      { input: 'transfer', toolCalls: [{ name: 'transfer', args: {} }] },
    ]);
    const chat = llm.chat.bind(llm);
    llm.chat = (options) => {
      const stream = chat(options);
      const next = stream.next.bind(stream);
      stream.next = async () => {
        const chunk = await next();
        if (chunk.done) await releaseGeneration.await;
        return chunk;
      };
      return stream;
    };
    const session = new AgentSession({ llm, turnHandling: { turnDetection: 'manual' } });
    try {
      await session.start({ agent });
      const activity = agent._agentActivity!;
      const speech = session.generateReply({ userInput: 'transfer' });
      await started.await;
      if (!generationPending) {
        releaseGeneration.resolve();
        await vi.waitFor(() => expect(activity.currentSpeech).toBeUndefined());
      }

      // Node has no public session.drain(); exercise the same activity drain directly.
      draining = activity.drain().then(() => {
        drained = true;
      });
      await vi.waitFor(() => expect(activity.schedulingPaused).toBe(true));
      if (generationPending) expect(activity.currentSpeech).toBe(speech);
      releaseTool.resolve();
      if (generationPending) {
        await vi.waitFor(() => expect(activity['_drainBlockedTasks'].size).toBeGreaterThan(0));
        expect(drained).toBe(false);
        releaseGeneration.resolve();
      }
      await draining;
      expect(await completed.await).toBe('done');
      expect(session._activity).toBe(activity);
      expect(activity.schedulingPaused).toBe(false);
    } finally {
      releaseTool.resolve();
      releaseGeneration.resolve();
      await draining;
      await session.close();
    }
  },
);
