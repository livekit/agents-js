// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { ThrowsPromise } from '@livekit/throws-transformer/throws';
import { type Context, type Span, context as otelContext, trace } from '@opentelemetry/api';
import type { ChatItem } from '../llm/index.js';
import { log } from '../log.js';
import { recordInvokeAgentDuration } from '../telemetry/otel_metrics.js';
import * as traceTypes from '../telemetry/trace_types.js';
import { recordException } from '../telemetry/utils.js';
import type { Task } from '../utils.js';
import { Event, Future, dedent, shortuuid } from '../utils.js';
import { functionCallStorage } from './agent.js';

/** Symbol used to identify SpeechHandle instances */
const SPEECH_HANDLE_SYMBOL = Symbol.for('livekit.agents.SpeechHandle');

/**
 * How long a cooperatively cancelled task may take to unwind after its abort signal fires.
 *
 * Has no python counterpart: there a cancelled task takes `CancelledError` at its next await point,
 * so `utils.aio.cancel_and_wait` needs no ceiling at all. Nothing here can cancel a pending
 * promise, so tasks are aborted cooperatively and waited on with this bound instead.
 *
 * All it bounds is how long an *aborted task body* takes to reach its own return — not how long
 * the work it started takes. The pipeline's tasks are stream pumps that re-check `signal.aborted`
 * each iteration, and `performToolExecutions` never awaits a user tool promise on this path: it
 * races the abort signal (`_waitForToolExecutionResult`), while `ToolExecutor` abandons a cancelled
 * tool outright and only *logs* if `execute()` is still running after `DRAIN_TOOL_TIMEOUT_MS`.
 * Non-cancellable tools are awaited to completion by `ToolExecutor.drain()` with no ceiling at all,
 * and the shutdown drain is a separate unbounded await that runs *after* this budget — so tool
 * cleanup is governed by the executor's own design, never by this value.
 *
 * Measured `performToolExecutions` settle latency after `abort()`: 0.04–0.33 ms across a tool that
 * observes its abort signal, a 4s tool that ignores it, a non-cancellable 4s tool, three concurrent
 * tools, and a tool body that never settles at all. The one shape that exceeds 2s is a task parked
 * on a tool-call stream that is never closed — it never settles, so no finite ceiling rescues it.
 *
 * 2s is therefore ample, and small enough that the two budgets an interrupted reply spends in
 * sequence (its task group, then its tool-execution task) still fit inside
 * {@link INTERRUPTION_TIMEOUT}; at 5s they would not.
 */
export const REPLY_TASK_CANCEL_TIMEOUT = 2000;

/**
 * How long an interrupted speech may keep running before its tasks are cancelled outright.
 *
 * Ports `INTERRUPTION_TIMEOUT` from `livekit-agents/livekit/agents/voice/speech_handle.py`,
 * including its value. It must stay strictly greater than {@link REPLY_TASK_CANCEL_TIMEOUT}: a
 * teardown may legitimately spend that whole budget, and its clock starts *after* the interrupt
 * that arms this watchdog, so at equal values the watchdog always preempts a slow-but-healthy
 * teardown and marks the handle done just as it resumes to commit its turn — trading a muted
 * session for a lost assistant message. The margin is what this watchdog costs: dead air the user
 * hears before the session recovers, against a session that without it never recovers at all.
 */
const INTERRUPTION_TIMEOUT = 5000;

/**
 * Type guard to check if a value is a SpeechHandle.
 */
export function isSpeechHandle(value: unknown): value is SpeechHandle {
  return (
    typeof value === 'object' &&
    value !== null &&
    SPEECH_HANDLE_SYMBOL in value &&
    (value as Record<symbol, boolean>)[SPEECH_HANDLE_SYMBOL] === true
  );
}

/**
 * Type returned by `await` on a {@link SpeechHandle}.
 *
 * Structurally identical to SpeechHandle at runtime — this alias only exists
 * to hide the `then` key from the static view. Without it, TypeScript's
 * `Awaited<T>` unwrap recurses through `SpeechHandle`'s own `.then` callback
 * parameter forever, emitting TS1062 ("Type is referenced directly or
 * indirectly in the fulfillment callback of its own 'then' method").
 * Omitting `then` terminates the unwrap because the pattern
 * `object & { then(...) }` no longer matches. In practice, calling `.then`
 * on an already-awaited handle has no meaningful use.
 *
 * @public
 */
export type ResolvedSpeechHandle = Omit<SpeechHandle, 'then'>;

/**
 * Thrown by {@link SpeechHandle.waitForPlayout} when called from inside the
 * function tool that owns this SpeechHandle. Awaiting the handle that owns the
 * currently-running tool creates a real circular wait — the handle's playout
 * cannot finish until the tool returns, but the tool is blocked waiting for
 * the playout.
 *
 * @public
 */
/**
 * Why a speech was interrupted, for the `agent_turn` trace: the user started talking over it
 * (`audio_activity`), a committed user turn preempted it (`user_turn`), or code did
 * (`programmatic`: `session.interrupt()`, a tool, teardown).
 */
export type InterruptionSource = 'audio_activity' | 'user_turn' | 'programmatic';

/** An open `agent_turn` handed from a discarded speech to its successor. @internal */
export interface AgentTurnCarry {
  span: Span;
  startedAt: number | undefined;
  agentName: string | undefined;
  /** Generation events already on the span, so `lk.generation_count` keeps counting. */
  generations: number;
}

/** How a speech came to continue another's `agent_turn` (see `SpeechHandle._continueAgentTurn`). */
export type AgentTurnContinuation = 'preemptive_discarded' | 'tool_reply';

export class SpeechHandleCircularWaitError extends Error {
  constructor(functionCallName: string) {
    super(dedent`
      Cannot call 'SpeechHandle.waitForPlayout()' from inside the function tool '${functionCallName}' that owns this SpeechHandle.
      This creates a circular wait: the speech handle is waiting for the function tool to complete, while the function tool is simultaneously waiting for the speech handle.
      To wait for the assistant's spoken response prior to running this tool, use RunContext.waitForPlayout() instead.
    `);
    this.name = 'SpeechHandleCircularWaitError';
  }
}

/**
 * Describes how the user provided input that triggered the current turn.
 * Used by modality-aware Instructions to pick the correct variant.
 *
 * @public
 */
export interface InputDetails {
  modality: 'audio' | 'text';
}

/** Default {@link InputDetails} used when no explicit value is provided. */
export const DEFAULT_INPUT_DETAILS: InputDetails = { modality: 'audio' };

/**
 * Controls and observes one agent speech turn.
 *
 * @public
 */
export class SpeechHandle {
  /** Priority for messages that should be played after all other messages in the queue */
  static SPEECH_PRIORITY_LOW = 0;
  /** Every speech generates by the VoiceAgent defaults to this priority. */
  static SPEECH_PRIORITY_NORMAL = 5;
  /** Priority for important messages that should be played before others. */
  static SPEECH_PRIORITY_HIGH = 10;

  private interruptFut = new Future<void>();
  private authorizedEvent = new Event();
  private scheduledFut = new Future<void>();
  private doneFut = new Future<void>();
  private generations: Future<void>[] = [];
  private _chatItems: ChatItem[] = [];
  /** @internal The first failure of an owned task, or the one the pipeline stored; see exception(). */
  _error: unknown;
  private interruptionHolds = 0;
  private interruptionHoldsRestore: boolean;

  /** @internal */
  _tasks: Task<void>[] = [];

  /** @internal */
  _numSteps = 1;
  /**
   * @internal Generation ids continue another speech's numbering when this speech carries on
   * its turn (a realtime tool reply, which the framework runs on a new handle): the base id and
   * the step the other speech had reached.
   */
  _generationBaseId?: string;
  /** @internal */
  _generationStepBase = 0;
  /** @internal The step of the last generation event this speech emitted on its turn. */
  _emittedGenerationStep?: number;
  /** @internal Generation events on the turn this speech owns, carried over on a handoff. */
  _agentTurnGenerations = 0;

  /**
   * @internal One `agent_turn` span for the whole speech, however many generations (LLM steps)
   * it takes; opened by the first reply task, ended with the speech in `_markDone`.
   */
  _agentTurnSpan?: Span;
  /** @internal - OpenTelemetry context for the agent turn span */
  _agentTurnContext?: Context;
  /** @internal - when the turn opened (performance.now), for the duration metric */
  _agentTurnStartedAt?: number;
  /** @internal - the agent the turn was opened for, for the duration metric */
  _agentTurnAgentName?: string;

  /** @internal - when the speech was scheduled, for the queue-wait attribute */
  _scheduledAt?: number;
  /** @internal - when generation was first authorized, for the queue-wait attribute */
  _authorizedAt?: number;
  /** @internal - the first interrupt's cause, for the agent_turn trace */
  _interruptSource?: InterruptionSource;

  /** @internal - used by AgentTask/RunResult final output plumbing */
  _maybeRunFinalOutput?: unknown;

  private itemAddedCallbacks: Set<(item: ChatItem) => void> = new Set();
  private doneCallbacks: Set<(sh: SpeechHandle) => void> = new Set();
  private interruptTimeout?: ReturnType<typeof setTimeout>;
  private logger = log();

  /** @internal Symbol marker for type identification */
  readonly [SPEECH_HANDLE_SYMBOL] = true;

  constructor(
    private _id: string,
    private _allowInterruptions: boolean,
    /** @internal */
    public _stepIndex: number,
    private _inputDetails: InputDetails = DEFAULT_INPUT_DETAILS,
    readonly parent?: SpeechHandle,
  ) {
    this.interruptionHoldsRestore = _allowInterruptions;
    this.doneFut.await.finally(() => {
      for (const callback of this.doneCallbacks) {
        callback(this);
      }
    });
  }

  static create(options?: {
    allowInterruptions?: boolean;
    stepIndex?: number;
    inputDetails?: InputDetails;
    parent?: SpeechHandle;
  }) {
    const {
      allowInterruptions = true,
      stepIndex = 0,
      inputDetails = DEFAULT_INPUT_DETAILS,
      parent,
    } = options ?? {};

    return new SpeechHandle(
      shortuuid('speech_'),
      allowInterruptions,
      stepIndex,
      inputDetails,
      parent,
    );
  }

  get inputDetails(): InputDetails {
    return this._inputDetails;
  }

  get interrupted(): boolean {
    return this.interruptFut.done;
  }

  get numSteps(): number {
    return this._numSteps;
  }

  get id(): string {
    return this._id;
  }

  /** @internal The step of the current generation in the turn's numbering (see `_generationBaseId`). */
  get _generationStep(): number {
    return this._generationStepBase + this._numSteps;
  }

  /** @internal The id of the current generation (LLM step) of this speech. */
  get _generationId(): string {
    return `${this._generationBaseId ?? this._id}_${this._generationStep}`;
  }

  /** @internal The id of the generation before the current one; undefined on the first. */
  get _parentGenerationId(): string | undefined {
    const step = this._generationStep;
    if (step <= 1) return undefined;
    return `${this._generationBaseId ?? this._id}_${step - 1}`;
  }

  get scheduled(): boolean {
    return this.scheduledFut.done;
  }

  get allowInterruptions(): boolean {
    return this._allowInterruptions;
  }

  /**
   * Allow or disallow interruptions on this SpeechHandle.
   *
   * When set to false, the SpeechHandle will no longer accept any incoming
   * interruption requests until re-enabled. If the handle is already
   * interrupted, clearing interruptions is not allowed.
   *
   * @param value - true to allow interruptions, false to disallow
   * @throws Error If attempting to disable interruptions when already interrupted
   */
  set allowInterruptions(value: boolean) {
    if (this.interrupted && !value) {
      throw new Error(
        'Cannot set allow_interruptions to False, the SpeechHandle is already interrupted',
      );
    }
    this._allowInterruptions = value;
  }

  /** @internal */
  _holdInterruptions(): void {
    if (this.interruptionHolds === 0) {
      this.interruptionHoldsRestore = this._allowInterruptions;
      this.allowInterruptions = false;
    }

    this.interruptionHolds += 1;
  }

  /** @internal */
  _releaseInterruptions(): void {
    this.interruptionHolds -= 1;
    if (this.interruptionHolds === 0) {
      // A forced interrupt lands regardless of the hold and leaves nothing to restore.
      try {
        this.allowInterruptions = this.interruptionHoldsRestore;
      } catch {
        // The handle was already interrupted.
      }
    }
  }

  done(): boolean {
    return this.doneFut.done;
  }

  /**
   * Returns the error that caused this SpeechHandle to complete, if any.
   *
   * @throws Error if the SpeechHandle is not done yet.
   */
  exception(): unknown {
    if (!this.doneFut.done) {
      throw new Error('SpeechHandle is not done yet');
    }

    return this._error;
  }

  get chatItems(): ChatItem[] {
    return this._chatItems;
  }

  /**
   * Interrupt the current speech generation.
   *
   * @param force - Interrupt even if this speech disallows interruptions.
   * @param source - Why, for the `agent_turn` trace (see {@link InterruptionSource}). The first
   *   interruption's cause is the one recorded.
   *
   * @throws Error If this speech handle is still running and does not allow interruptions.
   *
   * @returns The same speech handle that was interrupted.
   */
  interrupt(force: boolean = false, source: InterruptionSource = 'programmatic'): SpeechHandle {
    if (this.interrupted || this.done()) {
      // Already cancelled or finished: nothing to interrupt, and protection is moot.
      return this;
    }

    if (!force && !this.allowInterruptions) {
      throw new Error('This generation handle does not allow interruptions');
    }

    this._interruptSource = source; // first interrupt only: later calls return above
    this._cancel();
    return this;
  }

  /**
   * Waits for the entire assistant turn to complete playback.
   *
   * This method waits until the assistant has fully finished speaking,
   * including any finalization steps beyond initial response generation.
   * This is appropriate to call when you want to ensure the speech output
   * has entirely played out, including any tool calls and response follow-ups.
   *
   * @throws {@link SpeechHandleCircularWaitError} if called on the SpeechHandle
   * that owns the currently-running function tool — that would be a real
   * circular wait (the tool is blocked waiting for this handle, and the handle
   * cannot finish until the tool returns). Awaiting a *different* handle
   * scheduled from inside a tool (e.g.
   * `session.generateReply().waitForPlayout()`) is safe, because the main
   * speech-queue loop frees the owning handle's generation slot via
   * `_markGenerationDone()` before awaiting tool execution.
   */
  async waitForPlayout(): Promise<void> {
    const store = functionCallStorage.getStore();
    if (
      store?.functionCall &&
      store.speechHandle === this &&
      store.functionCall.extra.__livekit_agents_tool_non_blocking !== true
    ) {
      throw new SpeechHandleCircularWaitError(store.functionCall.name);
    }
    await this.doneFut.await;
  }

  /**
   * Makes the SpeechHandle awaitable: `await handle` resolves to the handle
   * itself once its playout has finished.
   *
   * Implementation note: naively returning `this` from `onFulfilled` would
   * trigger infinite Promise assimilation recursion (the returned thenable
   * gets unwrapped, calling `.then()` again, forever). We side-step this by
   * shadowing `.then` with `undefined` on the instance for the duration of
   * the synchronous `Resolve(this)` call. The spec-level IsCallable check
   * reads `undefined`, fulfills the outer promise with `this` as a plain
   * value, and we restore the prototype method immediately after.
   */
  then<R1 = ResolvedSpeechHandle, R2 = never>(
    onFulfilled?: ((value: ResolvedSpeechHandle) => R1 | PromiseLike<R1>) | null,
    onRejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): Promise<R1 | R2> {
    return this.waitForPlayout().then(() => {
      // Create an OWN property `then = undefined` on the instance. Own
      // properties shadow prototype properties during lookup, so for the
      // duration of this block `Get(this, "then")` returns undefined even
      // though the prototype's `then` method is untouched.
      (this as unknown as { then?: unknown }).then = undefined;
      try {
        // `onFulfilled(this)` invokes the Promise machinery's internal
        // Resolve synchronously. Resolve does Get(this, "then") here →
        // undefined → IsCallable(undefined) is false → FulfillPromise with
        // `this` as a plain value (spec: ECMA-262 PromiseResolveFunctions).
        // No assimilation job is queued, so no recursion into this method.
        return onFulfilled
          ? onFulfilled(this as unknown as ResolvedSpeechHandle)
          : (this as unknown as R1);
      } finally {
        // Remove the own property. Lookup now falls through to the
        // prototype's `then` again, so direct `handle.then(cb)` calls and
        // re-awaits keep working (the prototype method was never mutated).
        delete (this as unknown as { then?: unknown }).then;
      }
    }, onRejected);
  }

  async waitIfNotInterrupted(aw: Promise<unknown>[]): Promise<void> {
    const allTasksPromise = ThrowsPromise.all(aw);
    const fs: Promise<unknown>[] = [allTasksPromise, this.interruptFut.await];
    await ThrowsPromise.race(fs);
  }

  addDoneCallback(callback: (sh: SpeechHandle) => void) {
    if (this.done()) {
      queueMicrotask(() => callback(this));
      return;
    }
    this.doneCallbacks.add(callback);
  }

  removeDoneCallback(callback: (sh: SpeechHandle) => void) {
    this.doneCallbacks.delete(callback);
  }

  /**
   * @internal
   * @param source - Why, for the `agent_turn` trace: a preemptive attempt superseded by more of
   *   the user's turn is `user_turn`, one dropped by a barge-in `audio_activity`; a cancel with
   *   no cause (teardown, a pause) reads as programmatic. The first cause named stands.
   */
  _cancel(source?: InterruptionSource): SpeechHandle {
    if (this.done()) {
      return this;
    }

    if (!this.interruptFut.done) {
      if (source !== undefined) this._interruptSource = source;
      this.interruptFut.resolve();
      this.startInterruptTimeout();
    }

    return this;
  }

  /**
   * Arm the watchdog that force-cancels an interrupted speech that refuses to finish.
   *
   * Interrupting only resolves `interruptFut`; it is up to the owning reply task to notice and
   * unwind. A task parked on something the interruption itself cannot settle — most of the
   * pipeline reply's post-interrupt waits race the reply's abort signal, and nothing on the
   * ordinary interrupt path ever fires it — would otherwise never reach
   * `_markGenerationDone()`. The speech scheduling loop waits on that generation, so a single
   * stuck reply silently mutes the session for the rest of its life (#2065). Cancelling the
   * owned tasks aborts exactly the signal those waits are watching; `_markDone` then releases
   * the scheduler even if a task ignores its signal.
   *
   * Ported from python's `SpeechHandle._cancel`.
   */
  private startInterruptTimeout(): void {
    this.interruptTimeout = setTimeout(() => {
      this.interruptTimeout = undefined;
      this.logger.error(
        { speech_id: this._id, timeout: INTERRUPTION_TIMEOUT },
        'speech not done in time after interruption, cancelling the speech arbitrarily.',
      );
      for (const task of this._tasks) {
        task.cancel();
      }
      this._markDone();
    }, INTERRUPTION_TIMEOUT);
    // A pending watchdog must not be what keeps a process alive: handles that are interrupted
    // and then abandoned (never scheduled, so never marked done) would hold the loop open.
    this.interruptTimeout.unref?.();
  }

  private clearInterruptTimeout(): void {
    if (this.interruptTimeout !== undefined) {
      clearTimeout(this.interruptTimeout);
      this.interruptTimeout = undefined;
    }
  }

  /** @internal */
  get _hasGenerations(): boolean {
    return this.generations.length > 0;
  }

  /** @internal */
  _authorizeGeneration(): void {
    const fut = new Future<void>();
    this.generations.push(fut);
    this._authorizedAt ??= performance.now();
    this.authorizedEvent.set();
  }

  /** @internal */
  _clearAuthorization(): void {
    this.authorizedEvent.clear();
  }

  /** @internal */
  async _waitForAuthorization(): Promise<void> {
    await this.authorizedEvent.wait();
  }

  /** @internal */
  async _waitForGeneration(stepIdx: number = -1): Promise<void> {
    if (this.generations.length === 0) {
      throw new Error('cannot use wait_for_generation: no active generation is running.');
    }

    const index = stepIdx === -1 ? this.generations.length - 1 : stepIdx;
    const generation = this.generations[index];
    if (!generation) {
      throw new Error(`Generation at index ${index} not found.`);
    }
    return generation.await;
  }

  /** @internal */
  async _waitForScheduled(): Promise<void> {
    return this.scheduledFut.await;
  }

  /** @internal */
  _markGenerationDone(): void {
    if (this.generations.length === 0) {
      throw new Error('cannot use mark_generation_done: no active generation is running.');
    }

    const lastGeneration = this.generations[this.generations.length - 1];
    if (lastGeneration && !lastGeneration.done) {
      lastGeneration.resolve();
    }
  }

  /** @internal */
  _markDone(error?: unknown): void {
    if (!this.doneFut.done) {
      if (error !== undefined) {
        this._error = error;
      }
      this.doneFut.resolve();
    }
    // a pipeline LLM failure is stored on the handle before the tasks finish
    this.endAgentTurn(error !== undefined ? error : this._error);

    // Keep this outside the doneFut guard: if the handle is already done but a
    // generation future is still active, _waitForGeneration() must be released.
    if (this.generations.length > 0) {
      this._markGenerationDone();
    }

    this.clearInterruptTimeout();
  }

  /**
   * Detach this speech's open `agent_turn` so a successor can continue it.
   *
   * Used when a preemptive generation is discarded for another speech answering the same user
   * turn: the wasted generation stays visible under the one turn instead of becoming a turn of
   * its own. After this the speech ends without touching the span.
   * @internal
   */
  _takeAgentTurn(): AgentTurnCarry | undefined {
    const span = this._agentTurnSpan;
    if (span === undefined) return undefined;
    const carry: AgentTurnCarry = {
      span,
      startedAt: this._agentTurnStartedAt,
      agentName: this._agentTurnAgentName,
      generations: this._agentTurnGenerations,
    };
    this._agentTurnSpan = undefined;
    this._agentTurnContext = undefined;
    this._agentTurnStartedAt = undefined;
    this._agentTurnAgentName = undefined;
    this._agentTurnGenerations = 0;
    return carry;
  }

  /**
   * @internal Adopt the `agent_turn` taken from `from` (see {@link _takeAgentTurn}).
   *
   * - `preemptive_discarded` (the default): `from` was a preemptive attempt dropped for this
   *   speech; the span records that and takes this speech's id. Generation ids stay this
   *   speech's own, as in Python.
   * - `tool_reply`: this speech is the realtime tool reply the framework runs on a new handle
   *   after `from`'s tool calls; Python runs it on the same handle as its next step. The turn
   *   keeps `from`'s speech id and this speech's generations continue `from`'s numbering, so the
   *   trace reads as Python's: one turn, the reply's generation parented to the tool call's.
   */
  _continueAgentTurn(
    carry: AgentTurnCarry,
    from: SpeechHandle,
    continuation: AgentTurnContinuation = 'preemptive_discarded',
  ): void {
    // adopted even when sampled out: the duration metric still needs the start time
    const { span, startedAt, agentName } = carry;
    const own = this._agentTurnSpan;
    if (own !== undefined && own !== span) {
      // this speech already opened a turn of its own (the handoff came after its task started):
      // close it rather than leak an unended span that its children would dangle from
      own.addEvent('superseded_by_adopted_turn', { [traceTypes.ATTR_SPEECH_ID]: from.id });
      if (own.isRecording()) own.end();
    }
    if (continuation === 'preemptive_discarded') {
      span.addEvent('preemptive_generation_discarded', {
        [traceTypes.ATTR_SPEECH_ID]: from.id,
      });
      span.setAttribute(traceTypes.ATTR_SPEECH_ID, this.id);
    } else {
      this._generationBaseId = from._generationBaseId ?? from.id;
      this._generationStepBase = from._emittedGenerationStep ?? from._generationStep;
    }
    this._agentTurnSpan = span;
    this._agentTurnContext = trace.setSpan(otelContext.active(), span);
    this._agentTurnStartedAt = startedAt;
    this._agentTurnAgentName = agentName;
    this._agentTurnGenerations = carry.generations;
  }

  /** Close the speech's `agent_turn` span: the speech is done, whatever step it was on. */
  private endAgentTurn(error: unknown): void {
    const span = this._agentTurnSpan;
    this._agentTurnSpan = undefined;
    if (span === undefined) return;
    // the duration metric does not depend on the span being sampled in
    if (this._agentTurnStartedAt !== undefined && this._agentTurnAgentName !== undefined) {
      recordInvokeAgentDuration(
        (performance.now() - this._agentTurnStartedAt) / 1000,
        this._agentTurnAgentName,
      );
    }
    if (!span.isRecording()) return;
    if (error instanceof Error) {
      recordException(span, error);
    }
    span.end();
  }

  /** @internal */
  _markScheduled(): void {
    if (this._authorizedAt !== undefined) {
      // scheduled again after a generation ran (a tool reply on the same handle): this wait
      // is the new generation's own, not the first one's
      this._scheduledAt = performance.now();
      this._authorizedAt = undefined;
    } else {
      this._scheduledAt ??= performance.now();
    }
    if (!this.scheduledFut.done) {
      this.scheduledFut.resolve();
    }
  }

  /** @internal Milliseconds between the latest scheduling and its generation's authorization, once known. */
  _queueWait(): number | undefined {
    if (this._scheduledAt === undefined || this._authorizedAt === undefined) return undefined;
    return Math.max(this._authorizedAt - this._scheduledAt, 0);
  }

  /** @internal */
  _addItemAddedCallback(callback: (item: ChatItem) => void): void {
    this.itemAddedCallbacks.add(callback);
  }

  /** @internal */
  _removeItemAddedCallback(callback: (item: ChatItem) => void): void {
    this.itemAddedCallbacks.delete(callback);
  }

  /** @internal */
  _itemAdded(items: ChatItem[]): void {
    for (const item of items) {
      for (const cb of this.itemAddedCallbacks) {
        cb(item);
      }
      this._chatItems.push(item);
    }
  }
}
