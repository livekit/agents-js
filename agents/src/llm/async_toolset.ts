// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { JSONSchema7 } from 'json-schema';
import { z } from 'zod';
import { type JobContext, getJobContext } from '../job.js';
import { log } from '../log.js';
import { Task, delay } from '../utils.js';
import { type AgentSession } from '../voice/agent_session.js';
import { createToolOutput } from '../voice/generation.js';
import { RunContext, type UnknownUserData } from '../voice/run_context.js';
import { FunctionCall, type FunctionCallOutput } from './chat_context.js';
import {
  type FunctionTool,
  type JSONObject,
  type ToolContext,
  ToolError,
  type ToolOptions,
  tool,
} from './tool_context.js';
import { isZodObjectSchema, isZodSchema } from './zod-utils.js';

const logger = log();

const CONFIRM_DUPLICATE_PARAM = '_lk_agents_confirm_duplicate';

const UPDATE_TEMPLATE = `The tool \`{functionName}\` has updated, message: {message}
The task is still running, so DON'T make up or give information not included in the message above.`;

const DUPLICATE_REJECT = `Same tool \`{functionName}\` is already running:
{runningFunctionCalls}
If you want to cancel the existing one, call \`cancel_task\` with call_id.`;

const DUPLICATE_CONFIRM = `Same tool \`{functionName}\` is already running:
{runningFunctionCalls}
Re-call with confirm duplicate True to run a duplicate if needed,
or if you want to cancel the existing one, call \`cancel_task\` with call_id.`;

const REPLY_INSTRUCTIONS = `New results arrived from background tool calls (call_ids: {pendingCallIds}).
Summarize these results to the user naturally. Do NOT repeat information you have already told the user.`;

export type AsyncToolDuplicateMode = 'allow' | 'replace' | 'reject' | 'confirm';

type RunningTask<UserData = UnknownUserData> = {
  ctx: AsyncRunContext<UserData>;
  task: Task<void>;
};

type PendingUpdate<UserData = UnknownUserData> = {
  ctx: AsyncRunContext<UserData>;
  items: ToolItem[];
};

type ToolItem = FunctionCall | FunctionCallOutput;

const runningTasks = new Map<
  string,
  { jobCtx: JobContext | undefined; task: RunningTask<UnknownUserData> }
>();

function formatTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? '');
}

function stringifyOutput(output: unknown): string {
  if (typeof output === 'string') return output;
  return JSON.stringify(output);
}

function cloneFunctionCall(functionCall: FunctionCall, callId: string): FunctionCall {
  return FunctionCall.create({
    callId,
    name: functionCall.name,
    args: functionCall.args,
    extra: functionCall.extra,
    groupId: functionCall.groupId,
    thoughtSignature: functionCall.thoughtSignature,
  });
}

function makeToolItems(
  functionCall: FunctionCall,
  output: unknown,
  callId: string,
): ToolItem[] | undefined {
  const toolOutput = createToolOutput({
    toolCall: cloneFunctionCall(functionCall, callId),
    output,
    exception: output instanceof Error ? output : undefined,
  });

  if (!toolOutput.toolCallOutput) return undefined;
  return [toolOutput.toolCall, toolOutput.toolCallOutput];
}

function addConfirmDuplicateParameter<Parameters extends JSONObject>(
  parameters: FunctionTool<Parameters>['parameters'],
): FunctionTool<Parameters>['parameters'] {
  if (isZodSchema(parameters) && isZodObjectSchema(parameters)) {
    const zodObject = parameters as typeof parameters & {
      extend?: (shape: Record<string, unknown>) => typeof parameters;
    };
    try {
      return (
        zodObject.extend?.({
          [CONFIRM_DUPLICATE_PARAM]: z
            .boolean()
            .optional()
            .describe(
              'Set this to true to confirm you want to run a duplicate. Only do this when user confirms the duplication is needed.',
            ),
        }) ?? parameters
      );
    } catch {
      return parameters;
    }
  }

  const rawSchema = parameters as JSONSchema7;
  if (typeof rawSchema === 'object' && rawSchema !== null && !isZodSchema(rawSchema)) {
    return {
      ...rawSchema,
      properties: {
        ...(typeof rawSchema.properties === 'object' ? rawSchema.properties : {}),
        [CONFIRM_DUPLICATE_PARAM]: {
          type: 'boolean',
          description:
            'Set this to true to confirm you want to run a duplicate. Only do this when user confirms the duplication is needed.',
          default: false,
        },
      },
    } as FunctionTool<Parameters>['parameters'];
  }

  return parameters;
}

export class AsyncRunContext<UserData = UnknownUserData> extends RunContext<UserData> {
  private readonly pendingUpdateFuture: Promise<unknown>;
  private resolvePendingUpdate!: (value: unknown) => void;
  private rejectPendingUpdate!: (error: Error) => void;
  private pendingUpdateDone = false;
  private stepIdx = 0;

  constructor({
    runCtx,
    toolset,
  }: {
    runCtx: RunContext<UserData>;
    toolset: AsyncToolset<UserData>;
  }) {
    super(runCtx.session, runCtx.speechHandle, runCtx.functionCall);
    this._toolset = toolset;
    this.pendingUpdateFuture = new Promise<unknown>((resolve, reject) => {
      this.resolvePendingUpdate = resolve;
      this.rejectPendingUpdate = reject;
    });
  }

  /** @internal */
  readonly _toolset: AsyncToolset<UserData>;

  /**
   * Push an intermediate progress update into the conversation.
   *
   * The first update completes the original tool call immediately. Later updates
   * are inserted as background tool outputs and trigger a follow-up reply when the
   * agent is idle.
   */
  async update(message: string | unknown, options?: { template?: string }): Promise<void> {
    const output =
      typeof message === 'string'
        ? formatTemplate(options?.template ?? UPDATE_TEMPLATE, {
            functionName: this.functionCall.name,
            callId: this.functionCall.callId,
            message,
          })
        : message;

    if (!this.pendingUpdateDone) {
      this.pendingUpdateDone = true;
      this.functionCall.extra.__livekit_agents_tool_pending = true;
      this.resolvePendingUpdate(output);
      return;
    }

    this.stepIdx += 1;
    const items = makeToolItems(
      this.functionCall,
      output,
      `${this.functionCall.callId}_update_${this.stepIdx}`,
    );
    if (items) await this._toolset.enqueueReply(this, items);
  }

  /** @internal */
  _resolvePending(value: unknown): void {
    if (this.pendingUpdateDone) return;
    this.pendingUpdateDone = true;
    this.resolvePendingUpdate(value);
  }

  /** @internal */
  _rejectPending(error: Error): void {
    if (this.pendingUpdateDone) return;
    this.pendingUpdateDone = true;
    this.rejectPendingUpdate(error);
  }

  /** @internal */
  get _pending(): Promise<unknown> {
    return this.pendingUpdateFuture;
  }

  /** @internal */
  get _hasPendingUpdate(): boolean {
    return this.pendingUpdateDone;
  }
}

export interface AsyncToolOptions<UserData = UnknownUserData> extends ToolOptions<UserData> {
  ctx: AsyncRunContext<UserData>;
}

export interface AsyncToolsetOptions<UserData = UnknownUserData> {
  id?: string;
  tools?: ToolContext<UserData>;
  onDuplicateCall?: AsyncToolDuplicateMode;
}

export class AsyncToolset<UserData = UnknownUserData> {
  readonly id: string;
  readonly tools: ToolContext<UserData>;

  private readonly onDuplicateCall: AsyncToolDuplicateMode;
  private readonly localRunningTasks = new Map<string, RunningTask<UserData>>();
  private pendingUpdates: PendingUpdate<UserData>[] = [];
  private replyTask?: Task<void>;
  private closed = false;

  constructor({
    id = 'async_tools',
    tools = {},
    onDuplicateCall = 'confirm',
  }: AsyncToolsetOptions<UserData>) {
    this.id = id;
    this.onDuplicateCall = onDuplicateCall;
    this.tools = {
      ...Object.fromEntries(
        Object.entries(tools).map(([name, functionTool]) => [
          name,
          this.wrapTool(name, functionTool),
        ]),
      ),
      get_running_tasks: this.getRunningTasksTool(),
      cancel_task: this.cancelTaskTool(),
    } as ToolContext<UserData>;
  }

  async cancel(callId: string): Promise<boolean> {
    const running = this.localRunningTasks.get(callId);
    if (!running) return false;

    if (!running.ctx.speechHandle.allowInterruptions) {
      throw new ToolError(
        `Tool call ${callId} is not cancellable because interruptions are disallowed`,
      );
    }

    running.task.cancel();
    return true;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.replyTask?.cancel();
    for (const running of this.localRunningTasks.values()) {
      running.task.cancel();
    }
    await Promise.allSettled([
      ...(this.replyTask ? [this.replyTask.result] : []),
      ...Array.from(this.localRunningTasks.values()).map((running) => running.task.result),
    ]);
    this.localRunningTasks.clear();
  }

  async aclose(): Promise<void> {
    await this.close();
  }

  /** @internal */
  async enqueueReply(ctx: AsyncRunContext<UserData>, items: ToolItem[]): Promise<void> {
    if (this.closed) return;

    const agent = ctx.session.currentAgent;
    const chatCtx = agent.chatCtx.copy();
    chatCtx.insert(items);
    await agent.updateChatCtx(chatCtx);
    ctx.session._toolItemsAdded(items);

    this.pendingUpdates.push({ ctx, items });

    if (!this.replyTask || this.replyTask.done) {
      this.replyTask = Task.from(
        () => this.deliverReply(ctx.session),
        undefined,
        'asyncToolsetReply',
      );
    }
  }

  private wrapTool<Parameters extends JSONObject, Result>(
    name: string,
    functionTool: FunctionTool<Parameters, UserData, Result>,
  ): FunctionTool<Parameters, UserData, unknown> {
    return tool({
      description: functionTool.description,
      parameters:
        this.onDuplicateCall === 'confirm'
          ? addConfirmDuplicateParameter(functionTool.parameters)
          : functionTool.parameters,
      flags: functionTool.flags,
      execute: async (rawArgs: Parameters, opts: ToolOptions<UserData>) => {
        const args = { ...rawArgs } as Parameters & Record<string, unknown>;
        const confirmDuplicate = Boolean(args[CONFIRM_DUPLICATE_PARAM]);
        delete args[CONFIRM_DUPLICATE_PARAM];

        const duplicateResult = await this.checkDuplicate(name, confirmDuplicate);
        if (duplicateResult !== undefined) return duplicateResult;

        if (this.localRunningTasks.has(opts.toolCallId)) {
          throw new Error(`Task already running for call_id: ${opts.toolCallId}`);
        }

        const asyncCtx = new AsyncRunContext<UserData>({ runCtx: opts.ctx, toolset: this });
        const controller = new AbortController();

        const task = Task.from(
          async () => {
            let output: unknown;
            try {
              output = await functionTool.execute(args, {
                ...opts,
                ctx: asyncCtx,
                abortSignal: controller.signal,
              } as AsyncToolOptions<UserData>);
            } catch (error) {
              if (controller.signal.aborted) {
                logger.debug({ callId: opts.toolCallId, function: name }, 'async tool cancelled');
                asyncCtx._resolvePending(undefined);
                return;
              }

              output = error instanceof Error ? error : new Error(String(error));
              logger.error(
                { callId: opts.toolCallId, function: name, error },
                'error in async tool',
              );
            }

            if (!asyncCtx._hasPendingUpdate) {
              if (output instanceof Error) asyncCtx._rejectPending(output);
              else asyncCtx._resolvePending(output);
              return;
            }

            if (output === undefined || output === null) return;

            const items = makeToolItems(
              asyncCtx.functionCall,
              output,
              `${opts.toolCallId}_finished`,
            );
            if (items) await this.enqueueReply(asyncCtx, items);
          },
          controller,
          `asyncTool:${name}`,
        );

        const runningTask = { ctx: asyncCtx, task };
        this.localRunningTasks.set(opts.toolCallId, runningTask);
        const jobCtx = getJobContext(false);
        runningTasks.set(opts.toolCallId, {
          jobCtx,
          task: runningTask as unknown as RunningTask<UnknownUserData>,
        });

        task.addDoneCallback(() => {
          this.localRunningTasks.delete(opts.toolCallId);
          const registered = runningTasks.get(opts.toolCallId);
          if (registered?.task === runningTask) runningTasks.delete(opts.toolCallId);
        });

        return await asyncCtx._pending;
      },
    });
  }

  private getRunningTasksTool(): FunctionTool<Record<string, never>, UserData, unknown[]> {
    return tool({
      description: 'Get the list of running async tool calls across all async toolsets.',
      execute: async () => {
        const jobCtx = getJobContext(false);
        return Array.from(runningTasks.values())
          .filter((running) => running.jobCtx === jobCtx)
          .map((running) => running.task.ctx.functionCall.toJSON());
      },
    });
  }

  private cancelTaskTool(): FunctionTool<{ call_id: string }, UserData, string> {
    return tool({
      description: 'Cancel a running async tool call by call_id.',
      parameters: z.object({ call_id: z.string() }),
      execute: async ({ call_id }) => {
        const jobCtx = getJobContext(false);
        const running = runningTasks.get(call_id);
        if (
          running &&
          running.jobCtx === jobCtx &&
          (await running.task.ctx._toolset.cancel(call_id))
        ) {
          return `Task ${call_id} cancelled successfully.`;
        }
        return `Task ${call_id} not found or already completed.`;
      },
    });
  }

  private async deliverReply(session: AgentSession<UserData>): Promise<void> {
    await waitForInactive(session);

    const updates = this.pendingUpdates;
    this.pendingUpdates = [];

    const pendingItems = updates.flatMap((update) => update.items);
    if (pendingItems.length === 0) return;

    const agentChatItems = session.currentAgent.chatCtx.items;
    const latestPendingItem = pendingItems[pendingItems.length - 1];
    const latestAgentItem = agentChatItems[agentChatItems.length - 1];
    if (
      latestPendingItem &&
      latestAgentItem &&
      latestAgentItem.createdAt > latestPendingItem.createdAt
    ) {
      logger.debug('skipping async toolset reply because agent already spoke after updates');
      return;
    }

    const pendingCallIds = pendingItems
      .filter((item) => item.type === 'function_call_output')
      .map((item) => item.callId);

    session.generateReply({
      instructions: formatTemplate(REPLY_INSTRUCTIONS, {
        pendingCallIds: pendingCallIds.join(', '),
      }),
      toolChoice: 'none',
    });
  }

  private async checkDuplicate(
    functionName: string,
    confirmDuplicate: boolean,
  ): Promise<string | undefined> {
    if (this.onDuplicateCall === 'allow') return undefined;

    const runningFunctionCalls = Array.from(this.localRunningTasks.values())
      .map((running) => running.ctx.functionCall)
      .filter((functionCall) => functionCall.name === functionName);

    if (runningFunctionCalls.length === 0) return undefined;

    if (this.onDuplicateCall === 'replace') {
      const results = await Promise.allSettled(
        runningFunctionCalls.map((functionCall) => this.cancel(functionCall.callId)),
      );
      const errors = results.filter(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      );
      if (errors.length > 0) {
        throw new ToolError(
          `Failed to cancel duplicate tool calls: ${errors
            .map((error) => String(error.reason))
            .join('\n')}`,
        );
      }
      return undefined;
    }

    const runningFunctionCallsText = runningFunctionCalls
      .map((functionCall) => stringifyOutput(functionCall.toJSON()))
      .join('\n');

    if (this.onDuplicateCall === 'reject') {
      return formatTemplate(DUPLICATE_REJECT, {
        functionName,
        runningFunctionCalls: runningFunctionCallsText,
      });
    }

    if (this.onDuplicateCall === 'confirm' && !confirmDuplicate) {
      return formatTemplate(DUPLICATE_CONFIRM, {
        functionName,
        runningFunctionCalls: runningFunctionCallsText,
      });
    }

    return undefined;
  }
}

async function waitForInactive(session: AgentSession): Promise<void> {
  while (session.agentState === 'speaking' || session.agentState === 'thinking') {
    await delay(50);
  }
}
