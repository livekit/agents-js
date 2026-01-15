// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AgentHandoffItem, ChatItem } from '../../llm/chat_context.js';
import type { Task } from '../../utils.js';
import { Future } from '../../utils.js';
import type { Agent } from '../agent.js';
import { type SpeechHandle, isSpeechHandle } from '../speech_handle.js';
import {
  type AgentHandoffAssertOptions,
  type AgentHandoffEvent,
  type ChatMessageEvent,
  type EventType,
  type FunctionCallAssertOptions,
  type FunctionCallEvent,
  type FunctionCallOutputAssertOptions,
  type FunctionCallOutputEvent,
  type MessageAssertOptions,
  type RunEvent,
  isAgentHandoffEvent,
  isChatMessageEvent,
  isFunctionCallEvent,
  isFunctionCallOutputEvent,
} from './types.js';

// Environment variable for verbose output
const evalsVerbose = parseInt(process.env.LIVEKIT_EVALS_VERBOSE || '0', 10);

/**
 * Result of a test run containing recorded events and assertion utilities.
 *
 * @example
 * ```typescript
 * const result = await session.run({ userInput: 'Hello' });
 * result.expect.nextEvent().isMessage({ role: 'assistant' });
 * result.expect.noMoreEvents();
 * ```
 */
export class RunResult<T = unknown> {
  private _events: RunEvent[] = [];
  private doneFut = new Future<void>();
  private userInput?: string;

  private handles: Set<SpeechHandle | Task<void>> = new Set();
  private lastSpeechHandle?: SpeechHandle;
  private runAssert?: RunAssert;

  // TODO(brian): Add typed output support for parity with Python
  // - Add outputType?: new (...args: unknown[]) => T
  // - Add finalOutput?: T
  // - Implement markDone() to extract final_output from SpeechHandle.maybeRunFinalOutput
  // - See Python: run_result.py lines 182-201

  constructor(options?: { userInput?: string }) {
    this.userInput = options?.userInput;
  }

  /**
   * List of all recorded events generated during the run.
   */
  get events(): RunEvent[] {
    return this._events;
  }

  /**
   * Provides an assertion helper for verifying the run events.
   */
  get expect(): RunAssert {
    if (evalsVerbose) {
      const eventsStr = formatEvents(this._events)
        .map((line) => `      ${line}`)
        .join('\n');
      console.log(
        `\n+ RunResult {\n    userInput: "${this.userInput}"\n    events: [\n${eventsStr}\n    ]\n  }`,
      );
    }

    // Cache the RunAssert so cursor position persists across multiple .expect accesses
    if (!this.runAssert) {
      this.runAssert = new RunAssert(this);
    }
    return this.runAssert;
  }

  /**
   * Returns the final output of the run after completion.
   *
   * @throws Error - Not implemented yet.
   */
  get finalOutput(): T {
    // TODO(brian): Implement typed output support after AgentTask is implemented.
    throw new Error('finalOutput is not yet implemented in JS.');
  }

  /**
   * Indicates whether the run has finished processing all events.
   */
  done(): boolean {
    return this.doneFut.done;
  }

  /**
   * Wait for the RunResult to complete. Returns `this` for method chaining.
   *
   * @example
   * ```ts
   * const result = session.run({ userInput: 'Hi!' });
   * await result.wait();  // waits for completion
   * result.expect.nextEvent().isMessage({ role: 'assistant' });
   * ```
   */
  async wait(): Promise<this> {
    await this.doneFut.await;
    return this;
  }

  /**
   * @internal
   * Records an agent handoff event.
   */
  _agentHandoff(params: { item: AgentHandoffItem; oldAgent?: Agent; newAgent: Agent }): void {
    const event: AgentHandoffEvent = {
      type: 'agent_handoff',
      item: params.item,
      oldAgent: params.oldAgent,
      newAgent: params.newAgent,
    };
    const index = this._findInsertionIndex(event.item.createdAt);
    this._events.splice(index, 0, event);
  }

  /**
   * @internal
   * Called when a chat item is added during the run.
   */
  _itemAdded(item: ChatItem): void {
    if (this.doneFut.done) {
      return;
    }

    let event: RunEvent | undefined;

    if (item.type === 'message') {
      event = { type: 'message', item } as ChatMessageEvent;
    } else if (item.type === 'function_call') {
      event = { type: 'function_call', item } as FunctionCallEvent;
    } else if (item.type === 'function_call_output') {
      event = { type: 'function_call_output', item } as FunctionCallOutputEvent;
    }

    if (event) {
      const index = this._findInsertionIndex(item.createdAt);
      this._events.splice(index, 0, event);
    }
  }

  /**
   * @internal
   * Watch a speech handle or task for completion.
   */
  _watchHandle(handle: SpeechHandle | Task<void>): void {
    this.handles.add(handle);

    if (isSpeechHandle(handle)) {
      handle._addItemAddedCallback(this._itemAdded.bind(this));
    }

    handle.addDoneCallback(() => {
      this._markDoneIfNeeded(handle);
    });
  }

  /**
   * @internal
   * Unwatch a handle.
   */
  _unwatchHandle(handle: SpeechHandle | Task<void>): void {
    this.handles.delete(handle);

    if (isSpeechHandle(handle)) {
      handle._removeItemAddedCallback(this._itemAdded.bind(this));
    }
  }

  private _markDoneIfNeeded(handle: SpeechHandle | Task<void>): void {
    if (isSpeechHandle(handle)) {
      this.lastSpeechHandle = handle;
    }

    if ([...this.handles].every((h) => (isSpeechHandle(h) ? h.done() : h.done))) {
      this._markDone();
    }
  }

  private _markDone(): void {
    // TODO(brian): Implement final output support after AgentTask is implemented.
    // See Python run_result.py _mark_done() for reference:
    // - Check lastSpeechHandle._maybeRunFinalOutput
    // - Validate output type matches expected type
    // - Set exception or resolve based on output
    if (!this.doneFut.done) {
      this.doneFut.resolve();
    }
  }

  /**
   * Find the correct insertion index to maintain chronological order.
   */
  private _findInsertionIndex(createdAt: number): number {
    for (let i = this._events.length - 1; i >= 0; i--) {
      if (this._events[i]!.item.createdAt <= createdAt) {
        return i + 1;
      }
    }
    return 0;
  }
}

/**
 * Assertion helper for verifying run events in sequence.
 */
export class RunAssert {
  private _events: RunEvent[];
  private _currentIndex = 0;

  // TODO(brian): Add range access for parity with Python __getitem__ slice support.
  // - Add range(start?, end?) method returning EventRangeAssert
  // - EventRangeAssert should have containsFunctionCall(), containsMessage() methods
  // See Python run_result.py lines 247-251 for reference.

  constructor(runResult: RunResult) {
    this._events = runResult.events;
  }

  /**
   * Access a specific event by index for assertions.
   * Supports negative indices (e.g., -1 for last event).
   *
   * @example
   * ```typescript
   * result.expect.at(0).isMessage({ role: 'user' });
   * result.expect.at(-1).isMessage({ role: 'assistant' });
   * ```
   */
  at(index: number): EventAssert {
    let normalizedIndex = index;
    if (index < 0) {
      normalizedIndex = this._events.length + index;
    }

    if (normalizedIndex < 0 || normalizedIndex >= this._events.length) {
      this._raiseWithDebugInfo(
        `at(${index}) out of range (total events: ${this._events.length})`,
        normalizedIndex,
      );
    }

    return new EventAssert(this._events[normalizedIndex]!, this, normalizedIndex);
  }

  /**
   * Advance to the next event, optionally filtering by type.
   *
   * @example
   * ```typescript
   * result.expect.nextEvent().isMessage({ role: 'assistant' });
   * result.expect.nextEvent({ type: 'function_call' }).isFunctionCall({ name: 'foo' });
   * ```
   */
  nextEvent(options?: { type?: EventType }): EventAssert {
    while (true) {
      const evAssert = this._currentEvent();
      this._currentIndex++;

      if (!options?.type || evAssert.event().type === options.type) {
        return evAssert;
      }
    }
  }

  /**
   * Skip a specified number of upcoming events without assertions.
   *
   * @example
   * ```typescript
   * result.expect.skipNext(2);
   * ```
   */
  skipNext(count: number = 1): this {
    for (let i = 0; i < count; i++) {
      if (this._currentIndex >= this._events.length) {
        this._raiseWithDebugInfo(`Tried to skip ${count} event(s), but only ${i} were available.`);
      }
      this._currentIndex++;
    }
    return this;
  }

  /**
   * Assert that there are no further events.
   *
   * @example
   * ```typescript
   * result.expect.noMoreEvents();
   * ```
   */
  noMoreEvents(): void {
    if (this._currentIndex < this._events.length) {
      const event = this._events[this._currentIndex]!;
      this._raiseWithDebugInfo(`Expected no more events, but found: ${event.type}`);
    }
  }

  private _currentEvent(): EventAssert {
    if (this._currentIndex >= this._events.length) {
      this._raiseWithDebugInfo('Expected another event, but none left.');
    }
    return this.at(this._currentIndex);
  }

  /** @internal */
  _raiseWithDebugInfo(message: string, index?: number): never {
    const markerIndex = index ?? this._currentIndex;
    const eventsStr = formatEvents(this._events, markerIndex).join('\n');
    throw new AssertionError(`${message}\nContext around failure:\n${eventsStr}`);
  }
}

/**
 * Assertion wrapper for a single event.
 */
export class EventAssert {
  protected _event: RunEvent;
  protected _parent: RunAssert;
  protected _index: number;

  constructor(event: RunEvent, parent: RunAssert, index: number) {
    this._event = event;
    this._parent = parent;
    this._index = index;
  }

  /**
   * Get the underlying event.
   */
  event(): RunEvent {
    return this._event;
  }

  protected _raise(message: string): never {
    this._parent._raiseWithDebugInfo(message, this._index);
  }

  /**
   * Verify this event is a message with optional role matching.
   *
   * @example
   * ```typescript
   * result.expect.nextEvent().isMessage({ role: 'assistant' });
   * ```
   */
  isMessage(options?: MessageAssertOptions): MessageAssert {
    if (!isChatMessageEvent(this._event)) {
      this._raise(`Expected ChatMessageEvent, got ${this._event.type}`);
    }

    if (options?.role && this._event.item.role !== options.role) {
      this._raise(`Expected role '${options.role}', got '${this._event.item.role}'`);
    }

    return new MessageAssert(this._event, this._parent, this._index);
  }

  /**
   * Verify this event is a function call with optional name/args matching.
   *
   * @example
   * ```typescript
   * result.expect.nextEvent().isFunctionCall({ name: 'order_item', args: { id: 'big_mac' } });
   * ```
   */
  isFunctionCall(options?: FunctionCallAssertOptions): FunctionCallAssert {
    if (!isFunctionCallEvent(this._event)) {
      this._raise(`Expected FunctionCallEvent, got ${this._event.type}`);
    }

    if (options?.name && this._event.item.name !== options.name) {
      this._raise(`Expected call name '${options.name}', got '${this._event.item.name}'`);
    }

    if (options?.args) {
      let actual: Record<string, unknown>;
      try {
        actual = JSON.parse(this._event.item.args);
      } catch {
        this._raise(`Failed to parse function call arguments: ${this._event.item.args}`);
      }

      for (const [key, value] of Object.entries(options.args)) {
        if (!(key in actual) || actual[key] !== value) {
          this._raise(
            `For key '${key}', expected ${JSON.stringify(value)}, got ${JSON.stringify(actual[key])}`,
          );
        }
      }
    }

    return new FunctionCallAssert(this._event, this._parent, this._index);
  }

  /**
   * Verify this event is a function call output with optional matching.
   *
   * @example
   * ```typescript
   * result.expect.nextEvent().isFunctionCallOutput({ isError: false });
   * ```
   */
  isFunctionCallOutput(options?: FunctionCallOutputAssertOptions): FunctionCallOutputAssert {
    if (!isFunctionCallOutputEvent(this._event)) {
      this._raise(`Expected FunctionCallOutputEvent, got ${this._event.type}`);
    }

    if (options?.output !== undefined && this._event.item.output !== options.output) {
      this._raise(`Expected output '${options.output}', got '${this._event.item.output}'`);
    }

    if (options?.isError !== undefined && this._event.item.isError !== options.isError) {
      this._raise(`Expected isError=${options.isError}, got ${this._event.item.isError}`);
    }

    return new FunctionCallOutputAssert(this._event, this._parent, this._index);
  }

  /**
   * Verify this event is an agent handoff with optional type matching.
   *
   * @example
   * ```typescript
   * result.expect.nextEvent().isAgentHandoff({ newAgentType: MyAgent });
   * ```
   */
  isAgentHandoff(options?: AgentHandoffAssertOptions): AgentHandoffAssert {
    if (!isAgentHandoffEvent(this._event)) {
      this._raise(`Expected AgentHandoffEvent, got ${this._event.type}`);
    }

    // Cast to the correct type after validation
    const event = this._event as AgentHandoffEvent;

    if (options?.newAgentType) {
      const actualType = event.newAgent.constructor.name;
      if (!(event.newAgent instanceof options.newAgentType)) {
        this._raise(`Expected new_agent '${options.newAgentType.name}', got '${actualType}'`);
      }
    }

    return new AgentHandoffAssert(event, this._parent, this._index);
  }
}

/**
 * Assertion wrapper for message events.
 */
export class MessageAssert extends EventAssert {
  protected declare _event: ChatMessageEvent;

  constructor(event: ChatMessageEvent, parent: RunAssert, index: number) {
    super(event, parent, index);
  }

  override event(): ChatMessageEvent {
    return this._event;
  }

  // Phase 3: judge() method will be added here
}

/**
 * Assertion wrapper for function call events.
 */
export class FunctionCallAssert extends EventAssert {
  protected declare _event: FunctionCallEvent;

  constructor(event: FunctionCallEvent, parent: RunAssert, index: number) {
    super(event, parent, index);
  }

  override event(): FunctionCallEvent {
    return this._event;
  }
}

/**
 * Assertion wrapper for function call output events.
 */
export class FunctionCallOutputAssert extends EventAssert {
  protected declare _event: FunctionCallOutputEvent;

  constructor(event: FunctionCallOutputEvent, parent: RunAssert, index: number) {
    super(event, parent, index);
  }

  override event(): FunctionCallOutputEvent {
    return this._event;
  }
}

/**
 * Assertion wrapper for agent handoff events.
 */
export class AgentHandoffAssert extends EventAssert {
  protected declare _event: AgentHandoffEvent;

  constructor(event: AgentHandoffEvent, parent: RunAssert, index: number) {
    super(event, parent, index);
  }

  override event(): AgentHandoffEvent {
    return this._event;
  }
}

/**
 * Custom assertion error for test failures.
 */
export class AssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssertionError';
    Error.captureStackTrace?.(this, AssertionError);
  }
}

/**
 * Format events for debug output, optionally marking a selected index.
 */
function formatEvents(events: RunEvent[], selectedIndex?: number): string[] {
  const lines: string[] = [];

  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;
    let prefix = '';
    if (selectedIndex !== undefined) {
      prefix = i === selectedIndex ? '>>>' : '   ';
    }

    let line: string;
    if (isChatMessageEvent(event)) {
      const { role, content, interrupted } = event.item;
      const textContent =
        typeof content === 'string'
          ? content
          : Array.isArray(content)
            ? content.filter((c): c is string => typeof c === 'string').join(' ')
            : '';
      const truncated = textContent.length > 50 ? textContent.slice(0, 50) + '...' : textContent;
      line = `${prefix}[${i}] { type: "message", role: "${role}", content: "${truncated}", interrupted: ${interrupted} }`;
    } else if (isFunctionCallEvent(event)) {
      const { name, args } = event.item;
      line = `${prefix}[${i}] { type: "function_call", name: "${name}", args: ${args} }`;
    } else if (isFunctionCallOutputEvent(event)) {
      const { output, isError } = event.item;
      const truncated = output.length > 50 ? output.slice(0, 50) + '...' : output;
      line = `${prefix}[${i}] { type: "function_call_output", output: "${truncated}", isError: ${isError} }`;
    } else if (isAgentHandoffEvent(event)) {
      line = `${prefix}[${i}] { type: "agent_handoff", oldAgent: "${event.oldAgent?.constructor.name}", newAgent: "${event.newAgent.constructor.name}" }`;
    } else {
      line = `${prefix}[${i}] ${event}`;
    }

    lines.push(line);
  }

  return lines;
}
