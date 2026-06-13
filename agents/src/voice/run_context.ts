// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { FunctionCall, FunctionCallOutput } from '../llm/chat_context.js';
import type { Future } from '../utils.js';
import type { AgentActivity } from './agent_activity.js';
import type { AgentSession } from './agent_session.js';
import type { SpeechHandle } from './speech_handle.js';

export type UnknownUserData = unknown;

export type PromptTemplate<Args> = string | ((args: Args) => string);

export interface UpdatePromptArgs {
  functionName: string;
  callId: string;
  message: string;
}

export interface RunContextUpdateOptions {
  template?: PromptTemplate<UpdatePromptArgs>;
}

export interface AttachedToolExecutor {
  toolOptions: {
    updateTemplate: PromptTemplate<UpdatePromptArgs>;
  };
  enqueueReply(ctx: RunContext, items: [FunctionCall, FunctionCallOutput]): Promise<void>;
  replyTask?: Promise<void>;
}

export class RunContext<UserData = UnknownUserData> {
  private readonly initialStepIdx: number;
  private _executor?: AttachedToolExecutor;
  private _firstUpdateFuture?: Future<unknown>;
  private _updates: Array<[FunctionCall, FunctionCallOutput]> = [];
  constructor(
    public readonly session: AgentSession<UserData>,
    public readonly speechHandle: SpeechHandle,
    public readonly functionCall: FunctionCall,
  ) {
    this.initialStepIdx = speechHandle.numSteps - 1;
  }
  get userData(): UserData {
    return this.session.userData;
  }

  /**
   * Waits for the speech playout corresponding to this function call step.
   *
   * Unlike {@link SpeechHandle.waitForPlayout}, which waits for the full
   * assistant turn to complete (including all function tools),
   * this method only waits for the assistant's spoken response prior to running
   * this tool to finish playing.
   */
  async waitForPlayout() {
    return this.speechHandle._waitForGeneration(this.initialStepIdx);
  }

  get updates(): readonly [FunctionCall, FunctionCallOutput][] {
    return this._updates;
  }

  disallowInterruptions(): void {
    this.speechHandle.allowInterruptions = false;
  }

  async update(message: unknown, options: RunContextUpdateOptions = {}): Promise<void> {
    const updateStep = this._updates.length;
    const renderedMessage =
      typeof message === 'string'
        ? renderTemplate(options.template ?? this._executor?.toolOptions.updateTemplate, {
            functionName: this.functionCall.name,
            callId: this.functionCall.callId,
            message,
          })
        : message;
    const pair = this._makeUpdatePair(
      renderedMessage,
      updateStep > 0 ? `_update_${updateStep}` : '',
    );
    this._updates.push(pair);

    if (!this._executor) {
      return;
    }

    if (this._firstUpdateFuture && !this._firstUpdateFuture.done) {
      this._firstUpdateFuture.resolve(renderedMessage);
      this.functionCall.extra.__livekit_agents_tool_non_blocking = true;
      return;
    }

    await this._executor.enqueueReply(this, pair);
  }

  async foreground<T>(fn: (activity: AgentActivity) => Promise<T> | T): Promise<T> {
    await this._drainPendingReply();
    return this.session.waitForIdleAndHold(fn);
  }

  _attachExecutor(executor: AttachedToolExecutor, firstUpdateFuture: Future<unknown>): void {
    if (this._firstUpdateFuture !== undefined) {
      throw new Error('Executor already attached');
    }
    this._executor = executor;
    this._firstUpdateFuture = firstUpdateFuture;
  }

  _detachExecutor(): void {
    this._executor = undefined;
    this._firstUpdateFuture = undefined;
  }

  async _drainPendingReply(): Promise<void> {
    if (!this._executor?.replyTask) return;
    try {
      await this._executor.replyTask;
    } catch {
      // Reply task owns its own logging/errors.
    }
  }

  _makeUpdatePair(message: unknown, callIdSuffix: string = ''): [FunctionCall, FunctionCallOutput] {
    const fncCall = FunctionCall.create({
      callId: `${this.functionCall.callId}${callIdSuffix}`,
      name: this.functionCall.name,
      args: this.functionCall.args,
      extra: { ...this.functionCall.extra },
    });
    return [
      fncCall,
      FunctionCallOutput.create({
        name: fncCall.name,
        callId: fncCall.callId,
        output: stringifyToolOutput(message),
        isError: false,
      }),
    ];
  }

  _recordUpdatePair(pair: [FunctionCall, FunctionCallOutput]): void {
    this._updates.push(pair);
  }
}

function renderTemplate(
  template: PromptTemplate<UpdatePromptArgs> | undefined,
  args: UpdatePromptArgs,
): string {
  if (!template) return args.message;
  if (typeof template === 'function') return template(args);
  return template
    .replaceAll('{functionName}', args.functionName)
    .replaceAll('{callId}', args.callId)
    .replaceAll('{message}', args.message);
}

function stringifyToolOutput(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
