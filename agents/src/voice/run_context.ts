// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { FunctionCall, FunctionCallOutput } from '../llm/chat_context.js';
import type { Future } from '../utils.js';
import type { AgentActivity } from './agent_activity.js';
import type { AgentSession } from './agent_session.js';
import {
  AgentSessionEventTypes,
  type AgentStateChangedEvent,
  type UserStateChangedEvent,
} from './events.js';
import { type SpeechHandle, isSpeechHandle } from './speech_handle.js';

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

export type FillerSource = string | ((step: number) => SpeechHandle | string | null | undefined);

export interface RunContextFillerOptions {
  /**
   * Continuous-idle dwell, in milliseconds, before filler speech fires.
   * Defaults to 0, which fires as soon as the session is next idle.
   */
  delay?: number;
  /**
   * Cooldown, in milliseconds, before waiting for another idle dwell.
   * When omitted, filler speech fires at most once.
   */
  interval?: number;
  /** Maximum number of filler speeches to create. */
  maxSteps?: number;
  /** Optional external cancellation signal for the filler scheduler. */
  signal?: AbortSignal;
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
  private _fillerSchedulers: FillerScheduler[] = [];
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

  /**
   * Report progress from a long-running tool — and, on the first call, turn the tool
   * **non-blocking** so the conversation continues while `execute()` keeps running.
   *
   * Behavior depends on whether this is the first `update()` for the call:
   *
   * - **First call:** resolves the pending tool result with `message` and marks the
   *   function call non-blocking (`functionCall.extra.__livekit_agents_tool_non_blocking = true`).
   *   The framework treats `message` as the tool's immediate output to the LLM and returns
   *   control to the session, so the agent can speak/listen while the tool continues in the
   *   background. Whatever `execute()` ultimately returns is delivered later as a deferred reply.
   * - **Subsequent calls:** each `message` is enqueued via the owning executor and delivered as a
   *   fresh assistant turn, gated on the session being idle (so updates never talk over the user).
   *   The arrival cadence is therefore conversational, not immediate.
   *
   * Message rendering:
   * - A **string** is rendered through a template — {@link RunContextUpdateOptions.template} if
   *   provided, otherwise the executor's configured `updateTemplate` — with `{functionName}`,
   *   `{callId}`, and `{message}` substituted. The default template tells the model the task is
   *   still running and not to fabricate results.
   * - A **non-string** value is used as-is (no templating), letting a tool emit structured output.
   *
   * Every update is also recorded in {@link RunContext.updates} (with a `_update_N` call-id suffix
   * for the 2nd and later updates) so the full progress trail is preserved in chat history.
   *
   * No-op for delivery when the tool isn't attached to an async-capable executor (e.g. a plain
   * blocking tool): the update is still recorded but nothing is sent.
   *
   * @param message - Progress text (templated) or a structured value (sent verbatim).
   * @param options - Per-call overrides; see {@link RunContextUpdateOptions}.
   */
  async update(message: unknown, options: RunContextUpdateOptions = {}): Promise<void> {
    for (const scheduler of this._fillerSchedulers) {
      scheduler.resetDwell();
    }

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

  /**
   * Speak filler audio while a long-running tool step is in progress.
   *
   * The scheduler waits until the session is continuously idle for
   * {@link RunContextFillerOptions.delay} milliseconds, then speaks `source`
   * through {@link AgentSession.say}. When `interval` is set, it waits that
   * many milliseconds before starting another idle dwell; otherwise it fires at
   * most once. Agent speech, user speech, and {@link RunContext.update} reset
   * any pending dwell so filler does not race real conversation turns.
   *
   * @example
   * ```ts
   * await ctx.filler('Still searching, hang on.', { delay: 5000 }, async () => {
   *   return await slowLookup();
   * });
   * ```
   */
  async filler<T>(source: FillerSource, fn: () => Promise<T> | T): Promise<T>;
  async filler<T>(
    source: FillerSource,
    options: RunContextFillerOptions,
    fn: () => Promise<T> | T,
  ): Promise<T>;
  async filler<T>(
    source: FillerSource,
    optionsOrFn: RunContextFillerOptions | (() => Promise<T> | T),
    maybeFn?: () => Promise<T> | T,
  ): Promise<T> {
    const options = typeof optionsOrFn === 'function' ? {} : optionsOrFn;
    const fn = typeof optionsOrFn === 'function' ? optionsOrFn : maybeFn;
    if (!fn) {
      throw new Error('RunContext.filler requires a callback scope');
    }

    const scheduler = new FillerScheduler(this.session, this.speechHandle, source, options);
    this._fillerSchedulers.push(scheduler);
    try {
      return await fn();
    } finally {
      await scheduler.close();
      this._fillerSchedulers = this._fillerSchedulers.filter((s) => s !== scheduler);
    }
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

class FillerScheduler {
  private readonly abortController = new AbortController();
  private readonly delay: number;
  private readonly interval?: number;
  private readonly maxSteps?: number;
  private readonly task: Promise<void>;
  private dwellAbortController?: AbortController;
  private createdSpeeches: SpeechHandle[] = [];

  constructor(
    private readonly session: AgentSession,
    private readonly speechHandle: SpeechHandle,
    private readonly source: FillerSource,
    options: RunContextFillerOptions,
  ) {
    const { delay = 0, interval, maxSteps, signal } = options;
    if (delay < 0) {
      throw new Error('delay must be non-negative');
    }
    if (interval !== undefined && interval < 0) {
      throw new Error('interval must be non-negative when set');
    }
    if (maxSteps !== undefined && maxSteps < 0) {
      throw new Error('maxSteps must be non-negative when set');
    }

    this.delay = delay;
    this.interval = interval;
    this.maxSteps = maxSteps;

    if (signal?.aborted) {
      this.abortController.abort();
    } else {
      signal?.addEventListener('abort', () => this.abortController.abort(), { once: true });
    }

    this.task = this.run();
  }

  resetDwell(): void {
    this.dwellAbortController?.abort();
  }

  async close(): Promise<void> {
    this.abortController.abort();
    await this.task;
  }

  private async run(): Promise<void> {
    const onAgentStateChanged = (event: AgentStateChangedEvent): void => {
      if (event.newState === 'speaking' || event.newState === 'thinking') {
        this.resetDwell();
      }
    };
    const onUserStateChanged = (event: UserStateChangedEvent): void => {
      if (event.newState === 'speaking') {
        this.resetDwell();
      }
    };

    this.session.on(AgentSessionEventTypes.AgentStateChanged, onAgentStateChanged);
    this.session.on(AgentSessionEventTypes.UserStateChanged, onUserStateChanged);

    const loop = this.loop();
    try {
      await this.speechHandle.waitIfNotInterrupted([loop]);
    } finally {
      this.abortController.abort();
      this.session.off(AgentSessionEventTypes.AgentStateChanged, onAgentStateChanged);
      this.session.off(AgentSessionEventTypes.UserStateChanged, onUserStateChanged);
      await loop.catch(() => undefined);
    }
  }

  private async loop(): Promise<void> {
    while (!this.abortController.signal.aborted) {
      const idleReached = await waitUnlessAborted(
        this.session.waitForIdle(),
        this.abortController.signal,
      );
      if (!idleReached) return;

      this.dwellAbortController = new AbortController();
      const dwellCompleted = await sleepUnlessAborted(this.delay, [
        this.abortController.signal,
        this.dwellAbortController.signal,
      ]);
      this.dwellAbortController = undefined;
      if (!dwellCompleted) {
        continue;
      }

      const handle = this.createSpeech();
      if (handle) {
        this.createdSpeeches.push(handle);
      }

      if (
        this.interval === undefined ||
        (this.maxSteps !== undefined && this.createdSpeeches.length >= this.maxSteps)
      ) {
        return;
      }

      const intervalCompleted = await sleepUnlessAborted(this.interval, [
        this.abortController.signal,
      ]);
      if (!intervalCompleted) return;
    }
  }

  private createSpeech(): SpeechHandle | undefined {
    const value =
      typeof this.source === 'function' ? this.source(this.createdSpeeches.length) : this.source;
    if (typeof value === 'string') {
      return this.session.say(value);
    }
    if (isSpeechHandle(value)) {
      return value;
    }
    return undefined;
  }
}

async function waitUnlessAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return false;
  const abortPromise = new Promise<false>((resolve) => {
    signal.addEventListener('abort', () => resolve(false), { once: true });
  });
  const result = await Promise.race([promise.then(() => true), abortPromise]);
  return result;
}

async function sleepUnlessAborted(ms: number, signals: AbortSignal[]): Promise<boolean> {
  if (signals.some((signal) => signal.aborted)) return false;
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve(true);
    }, ms);
    const onAbort = () => {
      clearTimeout(timeout);
      cleanup();
      resolve(false);
    };
    const cleanup = () => {
      for (const signal of signals) {
        signal.removeEventListener('abort', onAbort);
      }
    };
    for (const signal of signals) {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}
