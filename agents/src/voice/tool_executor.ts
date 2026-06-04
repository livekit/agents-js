// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { ThrowsPromise } from '@livekit/throws-transformer/throws';
import type { ChatItem } from '../llm/chat_context.js';
import { FunctionCall, FunctionCallOutput } from '../llm/chat_context.js';
import {
  CONFIRM_DUPLICATE_PARAM,
  type DuplicateMode,
  type FunctionTool,
  type JSONObject,
  ToolError,
  ToolFlag,
  tool,
} from '../llm/tool_context.js';
import { log } from '../log.js';
import { Future, Task, toError } from '../utils.js';
import type { Agent } from './agent.js';
import { _setActivityTaskInfo } from './agent.js';
import type { AgentActivity } from './agent_activity.js';
import type { AgentSession } from './agent_session.js';
import type { RunContext } from './run_context.js';

export const UPDATE_TEMPLATE = `The tool \`{function_name}\` has updated, message: {message}
The task is still running, so DON'T make up or give information not included in the message above.`;

const DUPLICATE_REJECT = `Same tool \`{function_name}\` is already running:
{fnc_calls_text}
If you want to cancel the existing one, call \`lk_agents_cancel_task\` with call_id.`;

const DUPLICATE_CONFIRM = `Same tool \`{function_name}\` is already running:
{fnc_calls_text}
Re-call with confirm duplicate true to run a duplicate if needed,
or if you want to cancel the existing one, call \`lk_agents_cancel_task\` with call_id.`;

const REPLY_INSTRUCTIONS_AT_TAIL = `New results arrived from background tool calls (call_ids: {call_ids}).
Summarize the results naturally. Do NOT repeat information you have already told the user.`;

const REPLY_INSTRUCTIONS_MAYBE_COVERED = `New results arrived from background tool calls (call_ids: {call_ids}).
You may have already mentioned them in your most recent replies.
If you already told the user everything in these results, reply with an empty response (no text at all).
Otherwise, summarize only what you have not said yet, with a natural transition.
Never repeat information you have already told the user.`;

export type UpdatePromptArgs = {
  functionName: string;
  callId: string;
  message: string;
};

export type DuplicatePromptArgs = {
  functionName: string;
  fncCallsJson: string[];
  fncCallsText: string;
};

export type ReplyPromptArgs = {
  callIds: string[];
};

export type PromptTemplate<T> = string | ((args: T) => string);

export type AsyncToolOptions = {
  updateTemplate?: PromptTemplate<UpdatePromptArgs>;
  duplicateRejectTemplate?: PromptTemplate<DuplicatePromptArgs>;
  duplicateConfirmTemplate?: PromptTemplate<DuplicatePromptArgs>;
  replyAtTailTemplate?: PromptTemplate<ReplyPromptArgs>;
  replyMaybeCoveredTemplate?: PromptTemplate<ReplyPromptArgs>;
};

export type ResolvedAsyncToolOptions = Required<AsyncToolOptions>;

export type ToolHandlingOptions = {
  asyncOptions?: AsyncToolOptions;
};

export function renderTemplate<T extends object>(template: PromptTemplate<T>, args: T): string {
  if (typeof template === 'function') {
    return template(args);
  }

  return Object.entries(args).reduce(
    (rendered, [key, value]) => rendered.replaceAll(`{${toSnakeCase(key)}}`, String(value)),
    template,
  );
}

export function resolveAsyncToolOptions(config?: AsyncToolOptions): ResolvedAsyncToolOptions {
  return {
    updateTemplate: config?.updateTemplate ?? UPDATE_TEMPLATE,
    duplicateRejectTemplate: config?.duplicateRejectTemplate ?? DUPLICATE_REJECT,
    duplicateConfirmTemplate: config?.duplicateConfirmTemplate ?? DUPLICATE_CONFIRM,
    replyAtTailTemplate: config?.replyAtTailTemplate ?? REPLY_INSTRUCTIONS_AT_TAIL,
    replyMaybeCoveredTemplate:
      config?.replyMaybeCoveredTemplate ?? REPLY_INSTRUCTIONS_MAYBE_COVERED,
  };
}

type RunningTask = {
  ctx: RunContext;
  task: Task<void>;
  executor: ToolExecutor;
  allowCancellation: boolean;
};

type PendingUpdate = {
  ctx: RunContext;
  items: ChatItem[];
  target: Agent;
};

const runningTasksBySession = new WeakMap<AgentSession, Map<string, RunningTask>>();

const logger = log();

export class ToolExecutor {
  private readonly runningTasks = new Map<string, RunningTask>();
  private readonly pendingUpdates: PendingUpdate[] = [];
  private replyTask?: Task<void>;

  constructor(
    private readonly owningActivity: AgentActivity,
    readonly toolOptions: ResolvedAsyncToolOptions,
  ) {}

  async execute({
    tool,
    runCtx,
    parsedArgs,
    abortSignal,
  }: {
    tool: FunctionTool<JSONObject>;
    runCtx: RunContext;
    parsedArgs: JSONObject;
    abortSignal: AbortSignal;
  }): Promise<unknown> {
    const callId = runCtx.functionCall.callId;
    const functionName = runCtx.functionCall.name;
    const rawArgs = { ...parsedArgs };
    const confirmDuplicate = Boolean(rawArgs[CONFIRM_DUPLICATE_PARAM]);
    delete rawArgs[CONFIRM_DUPLICATE_PARAM];

    const duplicateResult = await this.checkDuplicate(functionName, {
      onDuplicate: tool.onDuplicate,
      confirmDuplicate,
    });
    if (duplicateResult !== undefined) {
      return duplicateResult;
    }

    if (this.runningTasks.has(callId)) {
      throw new Error(`Task already running for call_id: ${callId}`);
    }

    const firstUpdateFuture = new Future<unknown>();
    runCtx._attachExecutor(this, firstUpdateFuture);

    const allowCancellation = Boolean(tool.flags & ToolFlag.CANCELLABLE);
    const task = Task.from(
      async (controller) => {
        abortSignal.addEventListener('abort', () => controller.abort(), { once: true });
        try {
          const output = await tool.execute(rawArgs, {
            ctx: runCtx,
            toolCallId: callId,
            abortSignal: controller.signal,
          });

          if (!firstUpdateFuture.done) {
            firstUpdateFuture.resolve(output);
            return;
          }

          if (output !== undefined) {
            const pair = runCtx._makeUpdatePair(output, '_final');
            runCtx._updates.push(pair);
            await this._enqueueReply(runCtx, pair);
          }
        } catch (error) {
          if (!firstUpdateFuture.done) {
            firstUpdateFuture.reject(toError(error));
            return;
          }

          logger.error(
            { error, function: functionName, callId },
            'exception occurred while executing tool',
          );
          const pair = runCtx._makeUpdatePair(toError(error), '_final');
          runCtx._updates.push(pair);
          await this._enqueueReply(runCtx, pair);
        }
      },
      undefined,
      `toolExecutor:${functionName}`,
    );

    _setActivityTaskInfo(task, {
      speechHandle: runCtx.speechHandle,
      functionCall: runCtx.functionCall,
      inlineTask: false,
    });

    const runningTask = { ctx: runCtx, task, executor: this, allowCancellation };
    this.runningTasks.set(callId, runningTask);
    let sessionTasks = runningTasksBySession.get(runCtx.session);
    if (!sessionTasks) {
      sessionTasks = new Map();
      runningTasksBySession.set(runCtx.session, sessionTasks);
    }
    sessionTasks.set(callId, runningTask);

    task.addDoneCallback(() => {
      this.runningTasks.delete(callId);
      runningTasksBySession.get(runCtx.session)?.delete(callId);
      runCtx._detachExecutor();
    });

    return await firstUpdateFuture.await;
  }

  async cancel(callId: string): Promise<boolean> {
    const task = this.runningTasks.get(callId);
    if (!task) {
      return false;
    }
    if (!task.allowCancellation) {
      throw new ToolError(`Tool call ${callId} is not cancellable`);
    }
    if (!task.ctx.speechHandle.allowInterruptions) {
      throw new ToolError(
        `Tool call ${callId} is not cancellable because interruptions are disallowed`,
      );
    }
    await task.task.cancelAndWait();
    return true;
  }

  async cancelAll(options: { cancellableOnly?: boolean } = {}): Promise<void> {
    const tasks = [...this.runningTasks.values()];
    const toCancel = tasks.filter((task) => !options.cancellableOnly || task.allowCancellation);
    const toWait = options.cancellableOnly ? tasks.filter((task) => !task.allowCancellation) : [];

    await ThrowsPromise.allSettled(toCancel.map((task) => task.task.cancelAndWait()));
    await ThrowsPromise.allSettled(toWait.map((task) => task.task.result));
  }

  async drain(): Promise<void> {
    await this.cancelAll({ cancellableOnly: true });
  }

  async close(): Promise<void> {
    this.pendingUpdates.length = 0;
    const tasks = [...this.runningTasks.values()].map((task) => task.task.cancelAndWait());
    if (this.replyTask) {
      tasks.push(this.replyTask.cancelAndWait());
    }
    await ThrowsPromise.allSettled(tasks);
    this.runningTasks.clear();
  }

  async _enqueueReply(ctx: RunContext, items: ChatItem | ChatItem[]): Promise<void> {
    const itemList = Array.isArray(items) ? items : [items];
    const target = this.owningActivity.agent;
    const chatCtx = target.chatCtx.copy();
    chatCtx.insert(itemList);
    await target.updateChatCtx(chatCtx);
    ctx.session._toolItemsAdded(
      itemList.filter(
        (item) => item.type === 'function_call' || item.type === 'function_call_output',
      ),
    );

    this.pendingUpdates.push({ ctx, items: itemList, target });
    if (!this.replyTask || this.replyTask.done) {
      this.replyTask = Task.from(
        async () => this.deliverReply(ctx.session),
        undefined,
        'toolExecutor.deliverReply',
      );
      ctx.session._globalRunState?._watchHandle(this.replyTask);
    }
  }

  private async deliverReply(session: AgentSession): Promise<void> {
    try {
      await this.owningActivity.waitForIdle();
    } catch (error) {
      logger.debug({ error }, 'dropping tool reply because activity closed');
      this.pendingUpdates.length = 0;
      return;
    }

    const updates = this.pendingUpdates.splice(0);
    const pendingItems = updates.flatMap((update) => update.items);
    if (pendingItems.length === 0) {
      return;
    }

    const targetAgent = this.owningActivity.agent;
    const items = targetAgent.chatCtx.items;
    const lastPending = pendingItems[pendingItems.length - 1];
    const atTail = Boolean(lastPending && items.at(-1)?.id === lastPending.id);
    const callIds = pendingItems
      .filter((item) => item.type === 'function_call_output')
      .map((item) => item.callId);
    const template = atTail
      ? this.toolOptions.replyAtTailTemplate
      : this.toolOptions.replyMaybeCoveredTemplate;

    session.generateReply({
      instructions: renderTemplate(template, { callIds }),
      toolChoice: 'none',
    });
  }

  private async checkDuplicate(
    functionName: string,
    options: { onDuplicate: DuplicateMode; confirmDuplicate: boolean },
  ): Promise<string | undefined> {
    if (options.onDuplicate === 'allow') {
      return undefined;
    }

    const runningCalls = [...this.runningTasks.values()]
      .filter((task) => task.ctx.functionCall.name === functionName)
      .map((task) => task.ctx.functionCall);
    if (runningCalls.length === 0) {
      return undefined;
    }

    if (options.onDuplicate === 'replace') {
      const nonCancellable = runningCalls.filter(
        (call) => !this.runningTasks.get(call.callId)?.allowCancellation,
      );
      if (nonCancellable.length > 0) {
        throw new ToolError(
          `cannot replace duplicate call of ${functionName}: running call is not cancellable`,
        );
      }
      await ThrowsPromise.allSettled(runningCalls.map((call) => this.cancel(call.callId)));
      return undefined;
    }

    const fncCallsJson = runningCalls.map((call) => JSON.stringify(call.toJSON()));
    const args = {
      functionName,
      fncCallsJson,
      fncCallsText: fncCallsJson.join('\n'),
    };
    if (options.onDuplicate === 'reject') {
      return renderTemplate(this.toolOptions.duplicateRejectTemplate, args);
    }
    if (options.onDuplicate === 'confirm' && !options.confirmDuplicate) {
      return renderTemplate(this.toolOptions.duplicateConfirmTemplate, args);
    }
    return undefined;
  }
}

export function hasCancellableTool(toolCtx: Record<string, FunctionTool<JSONObject>>): boolean {
  return Object.values(toolCtx).some((tool) => Boolean(tool.flags & ToolFlag.CANCELLABLE));
}

export const getRunningTasksTool = tool({
  description: 'Get the list of running tool calls that are cancellable.',
  parameters: { type: 'object', properties: {}, required: [] },
  async execute(_args: JSONObject, { ctx }: { ctx: RunContext }) {
    return [...(runningTasksBySession.get(ctx.session)?.values() ?? [])]
      .filter((task) => task.allowCancellation)
      .map((task) => task.ctx.functionCall.toJSON());
  },
}) as FunctionTool<JSONObject>;

export const cancelTaskTool = tool({
  description: 'Cancel a running tool call by call_id.',
  parameters: {
    type: 'object',
    properties: {
      call_id: { type: 'string', description: 'The call_id of the tool call to cancel.' },
    },
    required: ['call_id'],
  },
  async execute(args: JSONObject, { ctx }: { ctx: RunContext }) {
    const callId = String(args.call_id ?? '');
    const task = runningTasksBySession.get(ctx.session)?.get(callId);
    if (!task) {
      throw new ToolError(`Task ${callId} not found`);
    }
    if (!(await task.executor.cancel(callId))) {
      throw new ToolError(`Task ${callId} not found or already completed`);
    }
    return `Task ${callId} cancelled successfully.`;
  },
}) as FunctionTool<JSONObject>;

export function makeUpdatePair(
  ctx: RunContext,
  message: unknown,
  suffix = '',
): [FunctionCall, FunctionCallOutput] {
  const toolCall = FunctionCall.create({
    callId: `${ctx.functionCall.callId}${suffix}`,
    name: ctx.functionCall.name,
    args: ctx.functionCall.args,
    extra: { ...ctx.functionCall.extra },
  });

  if (message instanceof ToolError) {
    return [
      toolCall,
      FunctionCallOutput.create({
        name: toolCall.name,
        callId: toolCall.callId,
        output: message.message,
        isError: true,
      }),
    ];
  }

  if (message instanceof Error) {
    return [
      toolCall,
      FunctionCallOutput.create({
        name: toolCall.name,
        callId: toolCall.callId,
        output: 'An internal error occurred',
        isError: true,
      }),
    ];
  }

  return [
    toolCall,
    FunctionCallOutput.create({
      name: toolCall.name,
      callId: toolCall.callId,
      output: message !== undefined ? JSON.stringify(message) : '',
      isError: false,
    }),
  ];
}

function toSnakeCase(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}
