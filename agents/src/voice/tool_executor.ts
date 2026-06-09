// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { ChatContext, FunctionCall, FunctionCallOutput } from '../llm/chat_context.js';
import {
  CONFIRM_DUPLICATE_PARAM,
  type DuplicateMode,
  type FunctionTool,
  type JSONObject,
  type ToolContextEntry,
  ToolError,
  ToolFlag,
  Toolset,
  isFunctionTool,
  tool,
} from '../llm/tool_context.js';
import { Future } from '../utils.js';
import type { AgentSession } from './agent_session.js';
import type { PromptTemplate, RunContext, UpdatePromptArgs } from './run_context.js';

export interface DuplicatePromptArgs {
  functionName: string;
  functionCallsJson: string[];
  functionCallsText: string;
}

export interface ReplyPromptArgs {
  callIds: string[];
}

export interface AsyncToolOptions {
  updateTemplate: PromptTemplate<UpdatePromptArgs>;
  duplicateRejectTemplate: PromptTemplate<DuplicatePromptArgs>;
  duplicateConfirmTemplate: PromptTemplate<DuplicatePromptArgs>;
  replyAtTailTemplate: PromptTemplate<ReplyPromptArgs>;
  replyMaybeCoveredTemplate: PromptTemplate<ReplyPromptArgs>;
}

export interface ToolHandlingOptions {
  asyncOptions?: Partial<AsyncToolOptions>;
}

export const UPDATE_TEMPLATE =
  'The tool `{functionName}` has updated, message: {message}\n' +
  "The task is still running, so DON'T make up or give information not included in the message above.";

export const DUPLICATE_REJECT =
  'Same tool `{functionName}` is already running:\n' +
  '{functionCallsText}\n' +
  'If you want to cancel the existing one, call `lk_agents_cancel_task` with call_id.';

export const DUPLICATE_CONFIRM =
  'Same tool `{functionName}` is already running:\n' +
  '{functionCallsText}\n' +
  'Re-call with confirm duplicate True to run a duplicate if needed,\n' +
  'or if you want to cancel the existing one, call `lk_agents_cancel_task` with call_id.';

export const REPLY_INSTRUCTIONS_AT_TAIL =
  'New results arrived from background tool calls (call_ids: {callIds}).\n' +
  'Summarize the results naturally. Do NOT repeat information you have already told the user.';

export const REPLY_INSTRUCTIONS_MAYBE_COVERED =
  'New results arrived from background tool calls (call_ids: {callIds}).\n' +
  'You may have already mentioned them in your most recent replies.\n' +
  'If you already told the user everything in these results, reply with an empty response (no text at all).\n' +
  'Otherwise, summarize only what you have not said yet, with a natural transition.\n' +
  'Never repeat information you have already told the user.';

export function resolveAsyncToolOptions(options?: Partial<AsyncToolOptions>): AsyncToolOptions {
  return {
    updateTemplate: options?.updateTemplate ?? UPDATE_TEMPLATE,
    duplicateRejectTemplate: options?.duplicateRejectTemplate ?? DUPLICATE_REJECT,
    duplicateConfirmTemplate: options?.duplicateConfirmTemplate ?? DUPLICATE_CONFIRM,
    replyAtTailTemplate: options?.replyAtTailTemplate ?? REPLY_INSTRUCTIONS_AT_TAIL,
    replyMaybeCoveredTemplate:
      options?.replyMaybeCoveredTemplate ?? REPLY_INSTRUCTIONS_MAYBE_COVERED,
  };
}

export function renderTemplate<Args extends Record<string, unknown>>(
  template: PromptTemplate<Args>,
  args: Args,
): string {
  if (typeof template === 'function') return template(args);
  return Object.entries(args).reduce(
    (result, [key, value]) => result.replaceAll(`{${key}}`, String(value)),
    template,
  );
}

type ToolExecutorAgent = {
  chatCtx: ChatContext;
  updateChatCtx(chatCtx: ChatContext): Promise<void> | void;
};

type ToolExecutorActivity = {
  agent: ToolExecutorAgent;
  waitForIdle(): Promise<void>;
};

type RunningTask = {
  ctx: RunContext;
  promise: Promise<void>;
  controller: AbortController;
  executor: ToolExecutor;
  allowCancellation: boolean;
};

type PendingUpdate = {
  ctx: RunContext;
  items: [FunctionCall, FunctionCallOutput];
  target: ToolExecutorAgent;
};

const runningTasks = new WeakMap<AgentSession, Map<string, RunningTask>>();

export const getRunningTasksTool = tool({
  name: 'lk_agents_get_running_tasks',
  description: 'Get the list of running tool calls that are cancellable.',
  execute: async (_, { ctx }) => getRunningTasks(ctx.session).map((call) => call.toJSON(true)),
});

export const cancelTaskTool = tool({
  name: 'lk_agents_cancel_task',
  description: 'Cancel a running tool call by call_id.',
  parameters: {
    type: 'object',
    properties: {
      call_id: { type: 'string' },
    },
    required: ['call_id'],
  },
  execute: async ({ call_id }: { call_id: string }, { ctx }) => {
    const task = runningTasks.get(ctx.session)?.get(call_id);
    if (!task) {
      throw new ToolError(`Task ${call_id} not found`);
    }
    const cancelled = await task.executor.cancel(call_id);
    if (!cancelled) {
      throw new ToolError(`Task ${call_id} not found or already completed`);
    }
    return `Task ${call_id} cancelled successfully.`;
  },
});

export class ToolExecutor {
  private runningTasks = new Map<string, RunningTask>();
  private pendingUpdates: PendingUpdate[] = [];
  private _replyTask?: Promise<void>;
  toolOptions: AsyncToolOptions;

  constructor({
    owningActivity,
    asyncToolOptions,
  }: {
    owningActivity?: ToolExecutorActivity | null;
    asyncToolOptions?: Partial<AsyncToolOptions>;
  } = {}) {
    this.owningActivity = owningActivity ?? null;
    this.toolOptions = resolveAsyncToolOptions(asyncToolOptions);
  }

  private owningActivity: ToolExecutorActivity | null;

  get replyTask(): Promise<void> | undefined {
    return this._replyTask;
  }

  setOwningActivity(activity: ToolExecutorActivity | null): void {
    this.owningActivity = activity;
  }

  setToolOptions(options?: Partial<AsyncToolOptions>): void {
    this.toolOptions = resolveAsyncToolOptions(options);
  }

  get hasRunningTasks(): boolean {
    return this.runningTasks.size > 0;
  }

  get hasCancellableRunningTasks(): boolean {
    return [...this.runningTasks.values()].some((task) => task.allowCancellation);
  }

  // Ref: python livekit/agents/voice/tool_executor.py:248-370
  async execute<Parameters extends JSONObject, UserData, Result>({
    tool,
    runCtx,
    rawArguments,
    abortSignal,
  }: {
    tool: FunctionTool<Parameters, UserData, Result>;
    runCtx: RunContext<UserData>;
    rawArguments: Parameters;
    abortSignal?: AbortSignal;
  }): Promise<unknown> {
    const callId = runCtx.functionCall.callId;
    const functionName = runCtx.functionCall.name;
    const args = { ...rawArguments } as Parameters & Record<string, unknown>;
    const confirmDuplicate =
      tool.onDuplicate === 'confirm' ? Boolean(args[CONFIRM_DUPLICATE_PARAM]) : undefined;
    delete args[CONFIRM_DUPLICATE_PARAM];

    const duplicateResult = await this.checkDuplicate(functionName, {
      onDuplicate: tool.onDuplicate,
      confirmDuplicate,
    });
    if (duplicateResult !== undefined) return duplicateResult;

    if (this.runningTasks.has(callId)) {
      throw new Error(`Task already running for call_id: ${callId}`);
    }

    const firstUpdateFuture = new Future<unknown>();
    runCtx._attachExecutor(this, firstUpdateFuture);

    const controller = new AbortController();
    const abort = () => controller.abort();
    abortSignal?.addEventListener('abort', abort, { once: true });

    const promise = this.runTool({
      tool,
      runCtx,
      rawArguments: args as Parameters,
      firstUpdateFuture,
      controller,
    }).finally(() => {
      this.runningTasks.delete(callId);
      runningTasks.get(runCtx.session)?.delete(callId);
      abortSignal?.removeEventListener('abort', abort);
      runCtx._detachExecutor();
    });

    const task: RunningTask = {
      ctx: runCtx,
      promise,
      controller,
      executor: this,
      allowCancellation: Boolean(tool.flags & ToolFlag.CANCELLABLE),
    };
    this.runningTasks.set(callId, task);
    let sessionTasks = runningTasks.get(runCtx.session);
    if (!sessionTasks) {
      sessionTasks = new Map();
      runningTasks.set(runCtx.session, sessionTasks);
    }
    sessionTasks.set(callId, task);

    return firstUpdateFuture.await;
  }

  async waitForAll(): Promise<void> {
    await Promise.allSettled([...this.runningTasks.values()].map((task) => task.promise));
    if (this._replyTask) await this._replyTask;
  }

  // Ref: python livekit/agents/voice/tool_executor.py:372-415
  async cancel(callId: string): Promise<boolean> {
    const task = this.runningTasks.get(callId);
    if (!task) return false;
    if (!task.allowCancellation) {
      throw new ToolError(`Tool call ${callId} is not cancellable`);
    }
    if (!task.ctx.speechHandle.allowInterruptions) {
      throw new ToolError(
        `Tool call ${callId} is not cancellable because interruptions are disallowed`,
      );
    }
    task.controller.abort();
    await task.promise.catch(() => undefined);
    return true;
  }

  async drain(): Promise<void> {
    const tasks = [...this.runningTasks.values()];
    await Promise.allSettled(
      tasks.map(async (task) => {
        if (task.allowCancellation) {
          task.controller.abort();
        }
        await task.promise;
      }),
    );
  }

  async aclose(): Promise<void> {
    this.pendingUpdates = [];
    const tasks = [...this.runningTasks.values()];
    for (const task of tasks) task.controller.abort();
    await Promise.allSettled(tasks.map((task) => task.promise));
    this.runningTasks.clear();
  }

  // Ref: python livekit/agents/voice/tool_executor.py:417-522
  async enqueueReply(ctx: RunContext, items: [FunctionCall, FunctionCallOutput]): Promise<void> {
    const target = this.owningActivity?.agent ?? getCurrentAgent(ctx.session);
    const chatCtx = target.chatCtx.copy();
    chatCtx.insert(items);
    await target.updateChatCtx(chatCtx);
    ctx.session.history.insert(items);

    this.pendingUpdates.push({ ctx, items, target });
    if (!this._replyTask) {
      this._replyTask = this.deliverReply(ctx.session).finally(() => {
        this._replyTask = undefined;
      });
      const runState = (
        ctx.session as unknown as {
          _globalRunState?: { _watchHandle?: (p: Promise<void>) => void };
        }
      )._globalRunState;
      runState?._watchHandle?.(this._replyTask);
    }
  }

  private async runTool<Parameters extends JSONObject, UserData, Result>({
    tool,
    runCtx,
    rawArguments,
    firstUpdateFuture,
    controller,
  }: {
    tool: FunctionTool<Parameters, UserData, Result>;
    runCtx: RunContext<UserData>;
    rawArguments: Parameters;
    firstUpdateFuture: Future<unknown>;
    controller: AbortController;
  }): Promise<void> {
    let output: unknown;
    let exception: unknown;
    try {
      output = await tool.execute(rawArguments, {
        ctx: runCtx,
        toolCallId: runCtx.functionCall.callId,
        abortSignal: controller.signal,
      });
    } catch (error) {
      exception = error;
    }

    if (controller.signal.aborted && !firstUpdateFuture.done) {
      firstUpdateFuture.resolve(undefined);
      return;
    }

    if (!firstUpdateFuture.done) {
      if (exception instanceof Error) {
        firstUpdateFuture.reject(exception);
      } else {
        firstUpdateFuture.resolve(output);
      }
      return;
    }

    if (exception !== undefined || output === undefined || output === null) {
      return;
    }
    const pair = runCtx._makeUpdatePair(output, '_final');
    runCtx._recordUpdatePair(pair);
    await this.enqueueReply(runCtx, pair);
  }

  private async checkDuplicate(
    functionName: string,
    { onDuplicate, confirmDuplicate }: { onDuplicate: DuplicateMode; confirmDuplicate?: boolean },
  ): Promise<string | undefined> {
    if (onDuplicate === 'allow') return undefined;

    const runningFunctionCalls = [...this.runningTasks.values()]
      .map((task) => task.ctx.functionCall)
      .filter((call) => call.name === functionName);
    if (runningFunctionCalls.length === 0) return undefined;

    if (onDuplicate === 'replace') {
      const nonCancellable = runningFunctionCalls.filter(
        (call) => !this.runningTasks.get(call.callId)?.allowCancellation,
      );
      if (nonCancellable.length > 0) {
        throw new ToolError(
          `cannot replace duplicate call of \`${functionName}\`: running call is not cancellable`,
        );
      }
      await Promise.all(runningFunctionCalls.map((call) => this.cancel(call.callId)));
      return undefined;
    }

    const functionCallsJson = runningFunctionCalls.map((call) => JSON.stringify(call.toJSON(true)));
    const args = {
      functionName,
      functionCallsJson,
      functionCallsText: functionCallsJson.join('\n'),
    };

    if (onDuplicate === 'reject') {
      return renderTemplate(this.toolOptions.duplicateRejectTemplate, args);
    }

    if (onDuplicate === 'confirm' && !confirmDuplicate) {
      return renderTemplate(this.toolOptions.duplicateConfirmTemplate, args);
    }

    return undefined;
  }

  private async deliverReply(session: AgentSession): Promise<void> {
    if (this.owningActivity) {
      await this.owningActivity.waitForIdle();
    } else if ('waitForIdle' in session && typeof session.waitForIdle === 'function') {
      await session.waitForIdle();
    }

    const updates = [...this.pendingUpdates];
    this.pendingUpdates = [];
    const pendingItems = updates.flatMap((update) => update.items);
    if (pendingItems.length === 0) return;

    const targetAgent = this.owningActivity?.agent ?? getCurrentAgent(session);
    const itemsToInsert = updates
      .filter((update) => update.target !== targetAgent)
      .flatMap((update) => update.items);
    let chatCtx: ChatContext | undefined;
    if (itemsToInsert.length > 0) {
      chatCtx = targetAgent.chatCtx.copy();
      chatCtx.insert(itemsToInsert);
    }

    const lastItem = pendingItems[pendingItems.length - 1]!;
    const targetItems = targetAgent.chatCtx.items;
    const atTail =
      targetItems.length > 0 && targetItems[targetItems.length - 1]!.id === lastItem.id;
    const callIds = pendingItems
      .filter((item): item is FunctionCallOutput => item.type === 'function_call_output')
      .map((item) => item.callId);
    const instructions = renderTemplate(
      atTail ? this.toolOptions.replyAtTailTemplate : this.toolOptions.replyMaybeCoveredTemplate,
      { callIds },
    );

    const generator = session as unknown as {
      generateReply?: (options: {
        instructions: string;
        toolChoice: 'none';
        chatCtx?: ChatContext;
      }) => {
        addDoneCallback?: (callback: (speech: unknown) => void) => void;
      };
    };
    generator.generateReply?.({
      instructions,
      toolChoice: 'none',
      chatCtx,
    });
  }
}

export function hasCancellableTool(tools: readonly ToolContextEntry[]): boolean {
  for (const entry of tools) {
    if (isFunctionTool(entry) && entry.flags & ToolFlag.CANCELLABLE) return true;
    if (entry instanceof Toolset && hasCancellableTool(entry.tools)) return true;
  }
  return false;
}

// Ref: python livekit/agents/voice/tool_executor.py:580-602
export function buildExecutorMap({
  toolsets,
  defaultExecutor,
}: {
  toolsets: readonly Toolset[];
  defaultExecutor: ToolExecutor;
}): Map<string, ToolExecutor> {
  const mapping = new Map<string, ToolExecutor>();

  const walk = (toolset: Toolset, current: ToolExecutor): void => {
    const scopedExecutor =
      '_executor' in toolset && toolset._executor instanceof ToolExecutor
        ? toolset._executor
        : current;
    for (const child of toolset.tools) {
      if (isFunctionTool(child)) {
        mapping.set(child.name, scopedExecutor);
      } else if (child instanceof Toolset) {
        walk(child, scopedExecutor);
      }
    }
  };

  for (const toolset of toolsets) {
    walk(toolset, defaultExecutor);
  }
  return mapping;
}

export function getRunningTasks(session: AgentSession): FunctionCall[] {
  return [...(runningTasks.get(session)?.values() ?? [])]
    .filter((task) => task.allowCancellation)
    .map((task) => FunctionCall.create({ ...task.ctx.functionCall }));
}

function getCurrentAgent(session: AgentSession): ToolExecutorAgent {
  return (session as unknown as { currentAgent: ToolExecutorAgent }).currentAgent;
}
