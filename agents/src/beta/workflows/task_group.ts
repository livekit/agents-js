// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import type { ChatContext } from '../../llm/chat_context.js';
import { LLM, ToolError, ToolFlag, tool } from '../../llm/index.js';
import { AgentTask } from '../../voice/agent.js';

interface FactoryInfo {
  taskFactory: () => AgentTask;
  id: string;
  description: string;
}

export interface TaskGroupResult {
  taskResults: Record<string, unknown>;
}

export interface TaskCompletedEvent {
  agentTask: AgentTask;
  taskId: string;
  result: unknown;
}

class OutOfScopeError extends ToolError {
  readonly targetTaskIds: string[];

  constructor(targetTaskIds: string[]) {
    super('out_of_scope');
    this.targetTaskIds = targetTaskIds;
  }
}

export interface TaskGroupOptions {
  summarizeChatCtx?: boolean;
  returnExceptions?: boolean;
  chatCtx?: ChatContext;
  onTaskCompleted?: (event: TaskCompletedEvent) => Promise<void>;
}

export class TaskGroup extends AgentTask<TaskGroupResult> {
  private _summarizeChatCtx: boolean;
  private _returnExceptions: boolean;
  private _visitedTasks = new Set<string>();
  private _registeredFactories = new Map<string, FactoryInfo>();
  private _taskCompletedCallback?: (event: TaskCompletedEvent) => Promise<void>;
  private _currentTask?: AgentTask;

  constructor(options: TaskGroupOptions = {}) {
    const { summarizeChatCtx = true, returnExceptions = false, chatCtx, onTaskCompleted } = options;

    super({ instructions: '*empty*', chatCtx });

    this._summarizeChatCtx = summarizeChatCtx;
    this._returnExceptions = returnExceptions;
    this._taskCompletedCallback = onTaskCompleted;
  }

  add(task: () => AgentTask, { id, description }: { id: string; description: string }): this {
    this._registeredFactories.set(id, { taskFactory: task, id, description });
    return this;
  }

  async onEnter(): Promise<void> {
    const taskStack = [...this._registeredFactories.keys()];
    const taskResults: Record<string, unknown> = {};

    while (taskStack.length > 0) {
      const taskId = taskStack.shift()!;
      const factoryInfo = this._registeredFactories.get(taskId)!;

      this._currentTask = factoryInfo.taskFactory();

      const sharedChatCtx = this._chatCtx.copy();
      await this._currentTask.updateChatCtx(sharedChatCtx);

      const outOfScopeTool = this.buildOutOfScopeTool(taskId);
      if (outOfScopeTool) {
        await this._currentTask.updateTools({
          ...this._currentTask.toolCtx,
          out_of_scope: outOfScopeTool,
        });
      }

      try {
        this._visitedTasks.add(taskId);
        const res = await this._currentTask.run();
        taskResults[taskId] = res;

        if (this._taskCompletedCallback) {
          await this._taskCompletedCallback({
            agentTask: this._currentTask,
            taskId,
            result: res,
          });
        }
      } catch (e) {
        if (e instanceof OutOfScopeError) {
          taskStack.unshift(taskId);
          for (let i = e.targetTaskIds.length - 1; i >= 0; i--) {
            taskStack.unshift(e.targetTaskIds[i]!);
          }
          continue;
        }

        if (this._returnExceptions) {
          taskResults[taskId] = e;
          continue;
        } else {
          this.complete(e instanceof Error ? e : new Error(String(e)));
          return;
        }
      }
    }

    try {
      if (this._summarizeChatCtx) {
        const sessionLlm = this.session.llm;
        if (!(sessionLlm instanceof LLM)) {
          throw new Error('summarizeChatCtx requires a standard LLM on the session');
        }

        // TODO(parity): Add excludeConfigUpdate when AgentConfigUpdate is ported
        const ctxToSummarize = this._chatCtx.copy({
          excludeInstructions: true,
          excludeHandoff: true,
          excludeEmptyMessage: true,
          excludeFunctionCall: true,
        });

        const summarizedChatCtx = await ctxToSummarize._summarize(sessionLlm, {
          keepLastTurns: 0,
        });
        await this.updateChatCtx(summarizedChatCtx);
      }
    } catch (e) {
      this.complete(new Error(`failed to summarize the chat_ctx: ${e}`));
      return;
    }

    this.complete({ taskResults });
  }

  private buildOutOfScopeTool(activeTaskId: string) {
    if (this._visitedTasks.size === 0) {
      return undefined;
    }

    const regressionTaskIds = new Set(this._visitedTasks);
    regressionTaskIds.delete(activeTaskId);

    if (regressionTaskIds.size === 0) {
      return undefined;
    }

    const taskRepr: Record<string, string> = {};
    for (const [id, info] of this._registeredFactories) {
      if (regressionTaskIds.has(id)) {
        taskRepr[id] = info.description;
      }
    }

    const taskIdValues = [...regressionTaskIds] as [string, ...string[]];

    const description =
      'Call to regress to other tasks according to what the user requested to modify, return the corresponding task ids. ' +
      'For example, if the user wants to change their email and there is a task with id "email_task" with a description of "Collect the user\'s email", return the id ("get_email_task"). ' +
      'If the user requests to regress to multiple tasks, such as changing their phone number and email, return both task ids in the order they were requested. ' +
      `The following are the IDs and their corresponding task description. ${JSON.stringify(taskRepr)}`;

    const currentTask = this._currentTask;
    const registeredFactories = this._registeredFactories;
    const visitedTasks = this._visitedTasks;

    return tool({
      description,
      flags: ToolFlag.IGNORE_ON_ENTER,
      parameters: z.object({
        task_ids: z.array(z.enum(taskIdValues)).describe('The IDs of the tasks requested'),
      }),
      execute: async ({ task_ids }: { task_ids: string[] }) => {
        for (const tid of task_ids) {
          if (!registeredFactories.has(tid) || !visitedTasks.has(tid)) {
            throw new ToolError(`Unable to regress, invalid task id ${tid}`);
          }
        }

        if (currentTask && !currentTask.done) {
          currentTask.complete(new OutOfScopeError(task_ids));
        }
      },
    });
  }
}
