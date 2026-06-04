// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { FunctionCall, FunctionCallOutput } from '../llm/chat_context.js';
import type { AgentSession } from './agent_session.js';
import type { SpeechHandle } from './speech_handle.js';
import {
  type PromptTemplate,
  type ToolExecutor,
  UPDATE_TEMPLATE,
  type UpdatePromptArgs,
  makeUpdatePair,
  renderTemplate,
} from './tool_executor.js';

export type UnknownUserData = unknown;

export class RunContext<UserData = UnknownUserData> {
  private readonly initialStepIdx: number;
  /** @internal */
  _updates: Array<[FunctionCall, FunctionCallOutput]> = [];
  private executor?: ToolExecutor;
  private firstUpdateFuture?: { done: boolean; resolve(value: unknown): void };

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

  async update(
    message: string | unknown,
    options: { template?: PromptTemplate<UpdatePromptArgs> } = {},
  ): Promise<void> {
    let output = message;
    if (typeof message === 'string') {
      const template =
        options.template ?? this.executor?.toolOptions.updateTemplate ?? UPDATE_TEMPLATE;
      output = renderTemplate(template, {
        functionName: this.functionCall.name,
        callId: this.functionCall.callId,
        message,
      });
    }

    const suffix = this._updates.length > 0 ? `_update_${this._updates.length}` : '';
    const pair = this._makeUpdatePair(output, suffix);
    this._updates.push(pair);

    if (!this.executor) {
      return;
    }

    if (this.firstUpdateFuture && !this.firstUpdateFuture.done) {
      this.functionCall.extra.__livekit_agents_tool_non_blocking = true;
      this.firstUpdateFuture.resolve(output);
      return;
    }

    await this.executor._enqueueReply(this, pair);
  }

  /** @internal */
  _makeUpdatePair(message: unknown, suffix = ''): [FunctionCall, FunctionCallOutput] {
    return makeUpdatePair(this, message, suffix);
  }

  /** @internal */
  _attachExecutor(
    executor: ToolExecutor,
    firstUpdateFuture: { done: boolean; resolve(value: unknown): void },
  ): void {
    if (this.executor) {
      throw new Error('Executor already attached');
    }
    this.executor = executor;
    this.firstUpdateFuture = firstUpdateFuture;
  }

  /** @internal */
  _detachExecutor(): void {
    this.executor = undefined;
    this.firstUpdateFuture = undefined;
  }
}
