// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { expect, it, vi } from 'vitest';
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

it.each([
  { timing: 'before handoff', shutdown: false },
  { timing: 'handoff requested', shutdown: false },
  { timing: 'direct handoff', shutdown: false },
  { timing: 'tool starts during drain', shutdown: false },
  { timing: 'during handoff onExit', shutdown: false },
  { timing: 'during handoff drain', shutdown: false },
  { timing: 'during handoff onExit', shutdown: true },
  { timing: 'during handoff drain', shutdown: true },
  { timing: 'during queued handoff onExit', shutdown: false },
  { timing: 'during queued handoff onExit', shutdown: true },
] as const)(
  'settles a non-cancellable tool that starts an AgentTask $timing (shutdown=$shutdown)',
  async ({ timing, shutdown }) => {
    const queued = timing === 'during queued handoff onExit';
    const duringOnExit =
      timing === 'during handoff onExit' || timing === 'direct handoff' || queued;
    const switchStarted = new Future<void>();
    const finishSwitch = new Future<void>();
    const generationStarted = new Future<void>();
    const emitTool = new Future<void>();
    const admission = new Future<void>();
    const started = new Future<void>();
    const result = new Future<unknown>();
    const exiting = new Future<void>();
    const finishExit = new Future<void>();
    const finishTool = new Future<void>();
    const taskEntered = vi.fn();
    const targetEntered = vi.fn();
    const root = Agent.create({ instructions: 'root' });
    const target = Agent.create({ instructions: 'target', onEnter: targetEntered });
    const task = AgentTask.create<string>({
      instructions: 'complete immediately',
      onEnter: async () => {
        taskEntered();
        task.complete('done');
      },
    });
    const agent = Agent.create({
      instructions: 'source',
      onEnter: async () => {
        if (queued) session.generateReply({ userInput: 'transfer' });
      },
      onExit: async () => {
        exiting.resolve();
        if (duringOnExit) await finishExit.await;
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
              if (shutdown) await finishTool.await;
              throw error;
            }
          },
        }),
        tool({
          name: 'switch',
          description: 'Hand off to the target.',
          execute: async () => {
            switchStarted.resolve();
            if (timing === 'tool starts during drain') await finishSwitch.await;
            return handoff({ agent: target });
          },
        }),
      ],
    });
    const llm = new UniqueCallLLM([
      { input: 'transfer', toolCalls: [{ name: 'transfer', args: {} }] },
      { input: 'switch', toolCalls: [{ name: 'switch', args: {} }] },
    ]);
    const chat = llm.chat.bind(llm);
    llm.chat = (options) => {
      const stream = chat(options);
      const next = stream.next.bind(stream);
      stream.next = async () => {
        const chunk = await next();
        if (
          timing === 'tool starts during drain' &&
          !chunk.done &&
          chunk.value.delta?.toolCalls?.some((call) => call.name === 'transfer')
        ) {
          generationStarted.resolve();
          await emitTool.await;
        }
        return chunk;
      };
      return stream;
    };
    const session = new AgentSession({
      llm,
      turnHandling: { turnDetection: 'manual' },
    });
    let closing: Promise<void> | undefined;
    let transition: Promise<void> | undefined;

    try {
      await session.start({ agent: queued ? root : agent });
      if (queued) {
        // Both requests initially block root, not the intermediate source activity.
        session.updateAgent(agent);
        session.updateAgent(target);
      } else {
        if (timing === 'tool starts during drain') {
          session.generateReply({ userInput: 'switch' });
          await switchStarted.await;
          await vi.waitFor(() => expect(agent._agentActivity!.currentSpeech).toBeUndefined());
        }
        session.generateReply({ userInput: 'transfer', allowInterruptions: false });
        if (timing === 'tool starts during drain') {
          await generationStarted.await;
          finishSwitch.resolve();
          await vi.waitFor(() => expect(agent._agentActivity!.schedulingPaused).toBe(true));
          expect(started.done).toBe(false);
          emitTool.resolve();
        }
      }
      await started.await;
      const sourceActivity = agent._agentActivity!;
      if (timing !== 'tool starts during drain') {
        await vi.waitFor(() => expect(sourceActivity.currentSpeech).toBeUndefined());
      }

      if (timing === 'before handoff') {
        admission.resolve();
        expect(await result.await).toBe('done');
      }

      if (timing === 'handoff requested') {
        // Keep the handoff queued while the tool attempts its inline task.
        const unlock = await session['activityLock'].lock();
        try {
          session.updateAgent(target);
          admission.resolve();
          expect(await result.await).toBeInstanceOf(ToolError);
          expect(exiting.done).toBe(false);
          expect(sourceActivity.schedulingPaused).toBe(false);
        } finally {
          unlock();
        }
      } else if (timing === 'direct handoff') {
        transition = session._updateActivity(target, { waitOnEnter: false });
      } else if (!queued && timing !== 'tool starts during drain') {
        session.generateReply({ userInput: 'switch' });
      }
      if (timing !== 'before handoff') {
        if (duringOnExit) {
          await exiting.await;
          expect(sourceActivity.schedulingPaused).toBe(false);
        } else if (timing !== 'handoff requested') {
          await vi.waitFor(() => expect(sourceActivity.schedulingPaused).toBe(true));
        }
        admission.resolve();
        expect(await result.await).toBeInstanceOf(ToolError);
        expect(await result.await).toHaveProperty('message', transitionError);
        expect(taskEntered).not.toHaveBeenCalled();
        if (shutdown) closing = session.close();
        finishTool.resolve();
        finishExit.resolve();
      } else {
        expect(taskEntered).toHaveBeenCalledOnce();
      }

      if (shutdown) {
        await closing;
        expect(targetEntered).not.toHaveBeenCalled();
      } else {
        await vi.waitFor(() => expect(targetEntered).toHaveBeenCalledOnce());
        expect(session.currentAgent).toBe(target);
        await session.close();
      }
      if (timing !== 'before handoff' && !shutdown) {
        const calls = agent.chatCtx.items.filter(
          (item) => item.type === 'function_call' && item.name === 'transfer',
        );
        expect(calls).toHaveLength(1);
        const outputs = agent.chatCtx.items.filter(
          (item) => item.type === 'function_call_output' && item.callId === calls[0]!.callId,
        );
        expect(outputs).toHaveLength(1);
        expect(outputs[0]).toMatchObject({ isError: true, output: transitionError });
      }
      expect(agent._agentActivity).toBeUndefined();
      expect(root._agentActivity).toBeUndefined();
      expect(task._agentActivity).toBeUndefined();
      expect(target._agentActivity).toBeUndefined();
    } finally {
      emitTool.resolve();
      finishSwitch.resolve();
      admission.resolve();
      finishTool.resolve();
      finishExit.resolve();
      await session.close();
      await transition;
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
