// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { JSONSchema7, JSONSchema7Definition } from 'json-schema';
import { z } from 'zod';
import { type JobContext, getJobContext } from '../job.js';
import { log } from '../log.js';
import { Future, Task, asError } from '../utils.js';
import type { AgentSession } from '../voice/agent_session.js';
import { RunContext, type UnknownUserData } from '../voice/run_context.js';
import { type ChatItem, FunctionCall, FunctionCallOutput } from './chat_context.js';
import {
  type FunctionTool,
  type JSONObject,
  type ToolContext,
  ToolError,
  isAgentHandoff,
  isToolError,
  tool,
} from './tool_context.js';
import { toJsonSchema } from './utils.js';
import { isZodSchema, parseZodSchema } from './zod-utils.js';

const UPDATE_TEMPLATE = `The tool \`{function_name}\` has updated, message: {message}
The task is still running, so DON'T make up or give information not included in the message above.`;

const DUPLICATE_REJECT = `Same tool \`{function_name}\` is already running:
{running_fnc_calls}
If you want to cancel the existing one, call \`cancelTask\` with callId.`;

const DUPLICATE_CONFIRM = `Same tool \`{function_name}\` is already running:
{running_fnc_calls}
Re-call with confirm duplicate true to run a duplicate if needed,
or if you want to cancel the existing one, call \`cancelTask\` with callId.`;

const REPLY_INSTRUCTIONS = `New results arrived from background tool calls (call_ids: {pending_call_ids}).
Summarize these results to the user naturally. Do NOT repeat information you have already told the user.`;

const CONFIRM_DUPLICATE_PARAM = '_lk_agents_confirm_duplicate';
const TOOL_PENDING_KEY = '__livekit_agents_tool_pending';

type DuplicateMode = 'allow' | 'replace' | 'reject' | 'confirm';

type AsyncToolExecutionOutput = {
  toolCall: FunctionCall;
  toolCallOutput?: FunctionCallOutput;
  rawOutput: unknown;
  rawException?: Error;
  replyRequired: boolean;
};

type RunningTask<UserData = UnknownUserData> = {
  ctx: AsyncRunContext<UserData>;
  execTask: Task<void>;
};

type RunningTaskView = {
  ctx: {
    functionCall: FunctionCall;
    _toolset: Pick<AsyncToolset, 'cancel'>;
  };
  execTask: Task<void>;
};

type PendingUpdate<UserData = UnknownUserData> = {
  ctx: AsyncRunContext<UserData>;
  items: ChatItem[];
};

const runningTasks = new Map<JobContext | undefined, Map<string, RunningTaskView>>();

function tasksForJob(jobCtx: JobContext | undefined): Map<string, RunningTaskView> {
  let tasks = runningTasks.get(jobCtx);
  if (!tasks) {
    tasks = new Map<string, RunningTaskView>();
    runningTasks.set(jobCtx, tasks);
  }
  return tasks;
}

function removeTaskForJob(jobCtx: JobContext | undefined, callId: string): void {
  const tasks = runningTasks.get(jobCtx);
  if (!tasks) return;

  tasks.delete(callId);
  if (tasks.size === 0) {
    runningTasks.delete(jobCtx);
  }
}

function formatTemplate(template: string, values: Record<string, string>): string {
  return Object.entries(values).reduce(
    (acc, [key, value]) => acc.replaceAll(`{${key}}`, value),
    template,
  );
}

function cloneFunctionCall(toolCall: FunctionCall, callId?: string | null): FunctionCall {
  const params = {
    callId: callId ?? toolCall.callId,
    name: toolCall.name,
    args: toolCall.args,
    createdAt: Date.now(),
    extra: toolCall.extra,
    groupId: toolCall.groupId,
    thoughtSignature: toolCall.thoughtSignature,
  };

  return FunctionCall.create(
    callId !== undefined && callId !== null ? params : { ...params, id: toolCall.id },
  );
}

function isValidToolOutput(toolOutput: unknown): boolean {
  const validTypes = ['string', 'number', 'boolean'];

  if (validTypes.includes(typeof toolOutput)) {
    return true;
  }

  if (toolOutput === undefined || toolOutput === null) {
    return true;
  }

  if (Array.isArray(toolOutput)) {
    return toolOutput.every(isValidToolOutput);
  }

  if (toolOutput instanceof Set) {
    return Array.from(toolOutput).every(isValidToolOutput);
  }

  if (toolOutput instanceof Map) {
    return Array.from(toolOutput.values()).every(isValidToolOutput);
  }

  if (toolOutput instanceof Object) {
    return Object.entries(toolOutput).every(
      ([key, value]) => validTypes.includes(typeof key) && isValidToolOutput(value),
    );
  }

  return false;
}

function makeToolOutput({
  toolCall,
  output,
  exception,
  callId,
}: {
  toolCall: FunctionCall;
  output: unknown;
  exception?: Error;
  callId?: string | null;
}): AsyncToolExecutionOutput {
  const logger = log();
  let finalOutput = output;
  let finalException = exception;

  if (output instanceof Error) {
    finalException = output;
    finalOutput = undefined;
  }

  const clonedCall = cloneFunctionCall(toolCall, callId);

  if (isToolError(finalException)) {
    return {
      toolCall: clonedCall,
      toolCallOutput: FunctionCallOutput.create({
        name: clonedCall.name,
        callId: clonedCall.callId,
        output: finalException.message,
        isError: true,
      }),
      rawOutput: finalOutput,
      rawException: finalException,
      replyRequired: true,
    };
  }

  if (finalException !== undefined) {
    return {
      toolCall: clonedCall,
      toolCallOutput: FunctionCallOutput.create({
        name: clonedCall.name,
        callId: clonedCall.callId,
        output: 'An internal error occurred',
        isError: true,
      }),
      rawOutput: finalOutput,
      rawException: finalException,
      replyRequired: true,
    };
  }

  let toolOutput = finalOutput;
  if (isAgentHandoff(finalOutput)) {
    toolOutput = finalOutput.returns;
  }

  if (!isValidToolOutput(toolOutput)) {
    logger.error(
      {
        callId: clonedCall.callId,
        output: finalOutput,
      },
      `AI function ${clonedCall.name} returned an invalid output`,
    );
    return {
      toolCall: clonedCall,
      rawOutput: finalOutput,
      rawException: finalException,
      replyRequired: true,
    };
  }

  return {
    toolCall: clonedCall,
    toolCallOutput: FunctionCallOutput.create({
      name: clonedCall.name,
      callId: clonedCall.callId,
      output: toolOutput !== undefined ? JSON.stringify(toolOutput) : '',
      isError: false,
    }),
    rawOutput: finalOutput,
    rawException: finalException,
    replyRequired: toolOutput !== undefined,
  };
}

function cloneSchema(schema: JSONSchema7): JSONSchema7 {
  return JSON.parse(JSON.stringify(schema)) as JSONSchema7;
}

function buildRawSchema<UserData>(
  toolName: string,
  fnTool: FunctionTool<JSONObject, UserData, unknown>,
): JSONSchema7 {
  const schema = cloneSchema(toJsonSchema(fnTool.parameters));
  schema.type ??= 'object';
  schema.properties ??= {};
  schema.title ??= toolName;
  schema.description ??= fnTool.description;
  return schema;
}

export const getRunningTasks = tool({
  description: 'Get the list of running async tool calls across all async toolsets.',
  execute: async () => {
    const jobCtx = getJobContext(false);
    const tasks = runningTasks.get(jobCtx);
    return tasks ? Array.from(tasks.values()).map((task) => task.ctx.functionCall.toJSON()) : [];
  },
});

export const cancelTask = tool({
  description: 'Cancel a running async tool call by callId.',
  parameters: z.object({ callId: z.string() }),
  execute: async ({ callId }) => {
    const jobCtx = getJobContext(false);
    const task = runningTasks.get(jobCtx)?.get(callId);
    if (task && (await task.ctx._toolset.cancel(callId))) {
      return `Task ${callId} cancelled successfully.`;
    }
    return `Task ${callId} not found or already completed.`;
  },
});

export class AsyncRunContext<UserData = UnknownUserData> extends RunContext<UserData> {
  /** @internal */
  readonly _toolset: AsyncToolset<UserData>;
  /** @internal */
  readonly _pendingFut = new Future<unknown>();
  /** @internal */
  _stepIdx = 0;

  constructor({
    runCtx,
    toolset,
  }: {
    runCtx: RunContext<UserData>;
    toolset: AsyncToolset<UserData>;
  }) {
    super(runCtx.session, runCtx.speechHandle, runCtx.functionCall);
    this._toolset = toolset;
  }

  async update(message: string | unknown, _template: string = UPDATE_TEMPLATE): Promise<void> {
    const output =
      typeof message === 'string'
        ? formatTemplate(_template, {
            function_name: this.functionCall.name,
            call_id: this.functionCall.callId,
            message,
          })
        : message;

    if (!this._pendingFut.done) {
      this._pendingFut.resolve(output);
      this.functionCall.extra[TOOL_PENDING_KEY] = true;
      return;
    }

    this._stepIdx += 1;
    const toolOutput = this._makeToolOutput(
      output,
      `${this.functionCall.callId}/update_${this._stepIdx}`,
    );
    if (!toolOutput.toolCallOutput) return;

    await this._toolset._enqueueReply(this, [toolOutput.toolCall, toolOutput.toolCallOutput]);
  }

  /** @internal */
  _makeToolOutput(output: unknown | Error, callId: string | null): AsyncToolExecutionOutput {
    const exception = output instanceof Error ? output : undefined;
    return makeToolOutput({
      toolCall: this.functionCall,
      output: exception ? undefined : output,
      exception,
      callId,
    });
  }
}

export class AsyncToolset<UserData = UnknownUserData> {
  readonly id: string;
  private readonly _onDuplicateCall: DuplicateMode;
  private readonly _tools: ToolContext<UserData>;
  private readonly _runningTasks = new Map<string, RunningTask<UserData>>();
  private readonly _pendingUpdates: PendingUpdate<UserData>[] = [];
  private _replyTask?: Task<void>;

  constructor({
    id,
    tools = {},
    onDuplicateCall = 'confirm',
  }: {
    id: string;
    tools?: ToolContext<UserData>;
    onDuplicateCall?: DuplicateMode;
  }) {
    this.id = id;
    this._onDuplicateCall = onDuplicateCall;
    this._tools = {};

    for (const [name, fnTool] of Object.entries(tools)) {
      this._tools[name] = this._wrapTool(name, fnTool);
    }

    this._tools.getRunningTasks = getRunningTasks as FunctionTool<
      Record<string, never>,
      UserData,
      unknown
    >;
    this._tools.cancelTask = cancelTask as FunctionTool<{ callId: string }, UserData, unknown>;
  }

  get tools(): ToolContext<UserData> {
    return { ...this._tools };
  }

  get toolCtx(): ToolContext<UserData> {
    return this.tools;
  }

  async cancel(callId: string): Promise<boolean> {
    const task = this._runningTasks.get(callId);
    if (!task) return false;

    if (!task.ctx.speechHandle.allowInterruptions) {
      throw new ToolError(
        `Tool call ${callId} is not cancellable because interruptions are disallowed`,
      );
    }

    await task.execTask.cancelAndWait();
    return true;
  }

  async aclose(): Promise<void> {
    const tasks = Array.from(this._runningTasks.values()).map((task) => task.execTask);
    if (this._replyTask) {
      tasks.push(this._replyTask);
    }
    await Promise.allSettled(tasks.map((task) => task.cancelAndWait()));
    this._runningTasks.clear();
  }

  private _wrapTool(
    name: string,
    fnTool: FunctionTool<JSONObject, UserData, unknown>,
  ): FunctionTool<JSONObject, UserData, unknown> {
    const rawSchema = buildRawSchema(name, fnTool);

    if (this._onDuplicateCall === 'confirm') {
      const props = rawSchema.properties as Record<string, JSONSchema7Definition>;
      props[CONFIRM_DUPLICATE_PARAM] = {
        type: 'boolean',
        description:
          'Set this to true to confirm you want to run a duplicate. Only do this when user confirms the duplication is needed.',
        default: false,
      };
    }

    return tool({
      description: fnTool.description,
      parameters: rawSchema,
      flags: fnTool.flags,
      execute: async (rawArguments, options) => {
        const callId = options.ctx.functionCall.callId;
        const fncName = options.ctx.functionCall.name;
        const args = { ...rawArguments };
        const confirmDuplicate = args[CONFIRM_DUPLICATE_PARAM] === true;
        delete args[CONFIRM_DUPLICATE_PARAM];

        const duplicateResult = await this._checkDuplicate(fncName, confirmDuplicate);
        if (duplicateResult !== null) {
          log().debug({ callId, function: fncName }, 'duplicate tool call rejected');
          return duplicateResult;
        }

        if (this._runningTasks.has(callId)) {
          throw new Error(`Task already running for callId: ${callId}`);
        }

        const asyncCtx = new AsyncRunContext({ runCtx: options.ctx, toolset: this });

        const execTask = Task.from(
          async (controller) => {
            let output: unknown;
            try {
              let parsedArgs = args;
              if (isZodSchema(fnTool.parameters)) {
                const result = await parseZodSchema<JSONObject>(fnTool.parameters, args);
                if (!result.success) {
                  throw result.error instanceof Error
                    ? result.error
                    : new Error(String(result.error));
                }
                parsedArgs = result.data;
              }

              output = await fnTool.execute(parsedArgs, {
                ...options,
                ctx: asyncCtx,
                abortSignal: controller.signal,
              });
            } catch (rawError) {
              if (controller.signal.aborted) {
                log().debug({ callId, function: fncName }, 'async tool cancelled');
                if (!asyncCtx._pendingFut.done) {
                  asyncCtx._pendingFut.resolve(undefined);
                }
                return;
              }

              output = asError(rawError);
              log().error({ callId, function: fncName, error: output }, 'error in async tool');
            }

            if (!asyncCtx._pendingFut.done) {
              if (output instanceof Error) {
                asyncCtx._pendingFut.reject(output);
              } else {
                asyncCtx._pendingFut.resolve(output);
              }
              return;
            }

            if (output === undefined || output === null) {
              return;
            }

            const toolOutput = asyncCtx._makeToolOutput(output, `${callId}/finished`);
            if (!toolOutput.toolCallOutput) return;

            await this._enqueueReply(asyncCtx, [toolOutput.toolCall, toolOutput.toolCallOutput]);
          },
          undefined,
          `asyncTool:${fncName}`,
        );

        const runningTask = { ctx: asyncCtx, execTask };
        this._runningTasks.set(callId, runningTask);

        const jobCtx = getJobContext(false);
        tasksForJob(jobCtx).set(callId, runningTask);

        execTask.addDoneCallback(() => {
          this._runningTasks.delete(callId);
          removeTaskForJob(jobCtx, callId);
        });

        return await asyncCtx._pendingFut.await;
      },
    });
  }

  /** @internal */
  async _enqueueReply(ctx: AsyncRunContext<UserData>, items: ChatItem[]): Promise<void> {
    const agent = ctx.session.currentAgent;
    const chatCtx = agent.chatCtx.copy();
    chatCtx.insert(items);
    await agent.updateChatCtx(chatCtx);

    this._pendingUpdates.push({ ctx, items });

    if (!this._replyTask || this._replyTask.done) {
      this._replyTask = Task.from(
        async (controller) => this._deliverReply(ctx.session, controller.signal),
        undefined,
        'AsyncToolset.deliverReply',
      );
    }
  }

  private async _deliverReply(
    session: AgentSession<UserData>,
    abortSignal: AbortSignal,
  ): Promise<void> {
    await session.waitForInactive({ abortSignal });
    if (abortSignal.aborted) return;

    const updates = this._pendingUpdates.splice(0, this._pendingUpdates.length);
    const pendingItems = updates.flatMap((update) => update.items);
    if (pendingItems.length === 0) return;

    const agentChatItems = session.currentAgent.chatCtx.items;
    const lastAgentItem = agentChatItems.at(-1);
    const lastPendingItem = pendingItems.at(-1);
    if (lastAgentItem && lastPendingItem && lastAgentItem.createdAt > lastPendingItem.createdAt) {
      log().debug('skipping async toolset reply - agent already spoke after updates');
      return;
    }

    const pendingCallIds = pendingItems
      .filter((item): item is FunctionCallOutput => item.type === 'function_call_output')
      .map((item) => item.callId);

    session.generateReply({
      instructions: formatTemplate(REPLY_INSTRUCTIONS, {
        pending_call_ids: pendingCallIds.join(', '),
      }),
      toolChoice: 'none',
    });
  }

  private async _checkDuplicate(
    fncName: string,
    confirmDuplicate: boolean,
  ): Promise<string | null> {
    if (this._onDuplicateCall === 'allow') {
      return null;
    }

    const runningFunctionCalls = Array.from(this._runningTasks.values())
      .map((task) => task.ctx.functionCall)
      .filter((functionCall) => functionCall.name === fncName);

    if (runningFunctionCalls.length === 0) {
      return null;
    }

    if (this._onDuplicateCall === 'replace') {
      const results = await Promise.allSettled(
        runningFunctionCalls.map((functionCall) => this.cancel(functionCall.callId)),
      );
      const errors = results.filter((result) => result.status === 'rejected');
      if (errors.length > 0) {
        const errorMessages = errors.map((result) => String(result.reason)).join('\n');
        throw new ToolError(`Failed to cancel duplicate tool calls: ${errorMessages}`);
      }
      return null;
    }

    const runningCalls = runningFunctionCalls
      .map((functionCall) => JSON.stringify(functionCall.toJSON()))
      .join('\n');

    if (this._onDuplicateCall === 'reject') {
      return formatTemplate(DUPLICATE_REJECT, {
        function_name: fncName,
        running_fnc_calls: runningCalls,
      });
    }

    if (this._onDuplicateCall === 'confirm' && !confirmDuplicate) {
      return formatTemplate(DUPLICATE_CONFIRM, {
        function_name: fncName,
        running_fnc_calls: runningCalls,
      });
    }

    return null;
  }
}
