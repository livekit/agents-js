// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import type { AgentHandoffItem, ChatItem, ChatRole } from '../../llm/chat_context.js';
import { ChatContext } from '../../llm/chat_context.js';
import type { LLM } from '../../llm/llm.js';
import { tool } from '../../llm/tool_context.js';
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

// Type for agent constructor (used in assertions)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AgentConstructor = new (...args: any[]) => Agent;

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
      event = { type: 'message', item };
    } else if (item.type === 'function_call') {
      event = { type: 'function_call', item };
    } else if (item.type === 'function_call_output') {
      event = { type: 'function_call_output', item };
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
   * Conditionally skip the next event if it matches the specified criteria.
   * Returns the event assertion if matched and skipped, or undefined if not matched.
   *
   * @example
   * ```typescript
   * // Skip optional assistant message before function call
   * result.expect.skipNextEventIf({ type: 'message', role: 'assistant' });
   * result.expect.nextEvent().isFunctionCall({ name: 'foo' });
   * ```
   */
  skipNextEventIf(
    options:
      | { type: 'message'; role?: ChatRole }
      | { type: 'function_call'; name?: string; args?: Record<string, unknown> }
      | { type: 'function_call_output'; output?: string; isError?: boolean }
      | { type: 'agent_handoff'; newAgentType?: AgentConstructor },
  ):
    | MessageAssert
    | FunctionCallAssert
    | FunctionCallOutputAssert
    | AgentHandoffAssert
    | undefined {
    if (this._currentIndex >= this._events.length) {
      return undefined;
    }

    try {
      const evAssert = this._currentEvent();

      if (options.type === 'message') {
        const { role } = options;
        const result = evAssert.isMessage({ role });
        this._currentIndex++;
        return result;
      } else if (options.type === 'function_call') {
        const { name, args } = options;
        const result = evAssert.isFunctionCall({
          name,
          args,
        });
        this._currentIndex++;
        return result;
      } else if (options.type === 'function_call_output') {
        const { output, isError } = options;
        const result = evAssert.isFunctionCallOutput({
          output,
          isError,
        });
        this._currentIndex++;
        return result;
      } else if (options.type === 'agent_handoff') {
        const { newAgentType } = options;
        const result = evAssert.isAgentHandoff({ newAgentType });
        this._currentIndex++;
        return result;
      }
    } catch {
      // Assertion failed, event doesn't match criteria
      return undefined;
    }

    return undefined;
  }

  /**
   * Get an EventRangeAssert for a range of events.
   * Similar to Python's slice access: expect[0:3] or expect[:]
   *
   * @param start - Start index (inclusive), defaults to 0
   * @param end - End index (exclusive), defaults to events.length
   *
   * @example
   * ```typescript
   * // Search all events
   * result.expect.range().containsFunctionCall({ name: 'foo' });
   * // Search first 3 events
   * result.expect.range(0, 3).containsMessage({ role: 'assistant' });
   * ```
   */
  range(start?: number, end?: number): EventRangeAssert {
    const startIdx = start ?? 0;
    const endIdx = end ?? this._events.length;
    const events = this._events.slice(startIdx, endIdx);
    return new EventRangeAssert(events, this, { start: startIdx, end: endIdx });
  }

  /**
   * Assert that a function call matching criteria exists anywhere in the events.
   *
   * @example
   * ```typescript
   * result.expect.containsFunctionCall({ name: 'order_item' });
   * ```
   */
  containsFunctionCall(options?: FunctionCallAssertOptions): FunctionCallAssert {
    return this.range().containsFunctionCall(options);
  }

  /**
   * Assert that a message matching criteria exists anywhere in the events.
   *
   * @example
   * ```typescript
   * result.expect.containsMessage({ role: 'assistant' });
   * ```
   */
  containsMessage(options?: MessageAssertOptions): MessageAssert {
    return this.range().containsMessage(options);
  }

  /**
   * Assert that a function call output matching criteria exists anywhere in the events.
   *
   * @example
   * ```typescript
   * result.expect.containsFunctionCallOutput({ isError: false });
   * ```
   */
  containsFunctionCallOutput(options?: FunctionCallOutputAssertOptions): FunctionCallOutputAssert {
    return this.range().containsFunctionCallOutput(options);
  }

  /**
   * Assert that an agent handoff matching criteria exists anywhere in the events.
   *
   * @example
   * ```typescript
   * result.expect.containsAgentHandoff({ newAgentType: MyAgent });
   * ```
   */
  containsAgentHandoff(options?: AgentHandoffAssertOptions): AgentHandoffAssert {
    return this.range().containsAgentHandoff(options);
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

    const event = this._event;

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
 * Assertion wrapper for a range of events.
 * Provides contains*() methods to search within the range.
 */
export class EventRangeAssert {
  private _events: RunEvent[];
  private _parent: RunAssert;
  private _range: { start: number; end: number };

  constructor(events: RunEvent[], parent: RunAssert, range: { start: number; end: number }) {
    this._events = events;
    this._parent = parent;
    this._range = range;
  }

  /**
   * Assert that a function call matching criteria exists in this event range.
   *
   * @example
   * ```typescript
   * result.expect.range(0, 3).containsFunctionCall({ name: 'foo' });
   * ```
   */
  containsFunctionCall(options?: FunctionCallAssertOptions): FunctionCallAssert {
    for (let idx = 0; idx < this._events.length; idx++) {
      const ev = this._events[idx]!;
      const candidate = new EventAssert(ev, this._parent, this._range.start + idx);
      try {
        return candidate.isFunctionCall(options);
      } catch {
        // Continue searching
      }
    }

    this._parent._raiseWithDebugInfo(
      `No FunctionCallEvent satisfying criteria found in range [${this._range.start}:${this._range.end}]`,
    );
  }

  /**
   * Assert that a message matching criteria exists in this event range.
   *
   * @example
   * ```typescript
   * result.expect.range(0, 2).containsMessage({ role: 'assistant' });
   * ```
   */
  containsMessage(options?: MessageAssertOptions): MessageAssert {
    for (let idx = 0; idx < this._events.length; idx++) {
      const ev = this._events[idx]!;
      const candidate = new EventAssert(ev, this._parent, this._range.start + idx);
      try {
        return candidate.isMessage(options);
      } catch {
        // Continue searching
      }
    }

    this._parent._raiseWithDebugInfo(
      `No ChatMessageEvent matching criteria found in range [${this._range.start}:${this._range.end}]`,
    );
  }

  /**
   * Assert that a function call output matching criteria exists in this event range.
   *
   * @example
   * ```typescript
   * result.expect.range(1, 4).containsFunctionCallOutput({ isError: true });
   * ```
   */
  containsFunctionCallOutput(options?: FunctionCallOutputAssertOptions): FunctionCallOutputAssert {
    for (let idx = 0; idx < this._events.length; idx++) {
      const ev = this._events[idx]!;
      const candidate = new EventAssert(ev, this._parent, this._range.start + idx);
      try {
        return candidate.isFunctionCallOutput(options);
      } catch {
        // Continue searching
      }
    }

    this._parent._raiseWithDebugInfo(
      `No FunctionCallOutputEvent matching criteria found in range [${this._range.start}:${this._range.end}]`,
    );
  }

  /**
   * Assert that an agent handoff matching criteria exists in this event range.
   *
   * @example
   * ```typescript
   * result.expect.range(0, 3).containsAgentHandoff({ newAgentType: MyAgent });
   * ```
   */
  containsAgentHandoff(options?: AgentHandoffAssertOptions): AgentHandoffAssert {
    for (let idx = 0; idx < this._events.length; idx++) {
      const ev = this._events[idx]!;
      const candidate = new EventAssert(ev, this._parent, this._range.start + idx);
      try {
        return candidate.isAgentHandoff(options);
      } catch {
        // Continue searching
      }
    }

    this._parent._raiseWithDebugInfo(
      `No AgentHandoffEvent matching criteria found in range [${this._range.start}:${this._range.end}]`,
    );
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

  /**
   * Evaluate whether the message fulfills the given intent using an LLM.
   *
   * @param llm - LLM instance for judgment
   * @param options - Options containing the intent description
   * @returns Self for chaining further assertions
   *
   * @example
   * ```typescript
   * await result.expect
   *   .nextEvent()
   *   .isMessage({ role: 'assistant' })
   *   .judge(llm, { intent: 'should ask for the drink size' });
   * ```
   */
  async judge(llm: LLM, options: { intent: string }): Promise<MessageAssert> {
    const { intent } = options;

    // Extract text content from message
    const content = this._event.item.content;
    const msgContent =
      typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content.filter((c): c is string => typeof c === 'string').join(' ')
          : '';

    if (!msgContent) {
      this._raise('The chat message is empty.');
    }

    if (!intent) {
      this._raise('Intent is required to judge the message.');
    }

    // Create the check_intent tool
    const checkIntentTool = tool({
      description:
        'Determines whether the message correctly fulfills the given intent. ' +
        'Returns success=true if the message satisfies the intent, false otherwise. ' +
        'Provide a concise reason justifying the result.',
      parameters: z.object({
        success: z.boolean().describe('Whether the message satisfies the intent'),
        reason: z.string().describe('A concise explanation justifying the result'),
      }),
      execute: async ({ success, reason }: { success: boolean; reason: string }) => {
        return { success, reason };
      },
    });

    // Create chat context for the judge
    const chatCtx = ChatContext.empty();
    chatCtx.addMessage({
      role: 'system',
      content:
        'You are a test evaluator for conversational agents.\n' +
        'You will be shown a message and a target intent. Determine whether the message accomplishes the intent.\n' +
        'Only respond by calling the `check_intent(success: bool, reason: str)` function with your final judgment.\n' +
        'Be strict: if the message does not clearly fulfill the intent, return `success = false` and explain why.',
    });
    chatCtx.addMessage({
      role: 'user',
      content:
        'Check if the following message fulfills the given intent.\n\n' +
        `Intent:\n${intent}\n\n` +
        `Message:\n${msgContent}`,
    });

    // Call the LLM with the check_intent tool
    let toolArgs: { success: boolean; reason: string } | undefined;

    const stream = llm.chat({
      chatCtx,
      toolCtx: { check_intent: checkIntentTool },
      toolChoice: { type: 'function', function: { name: 'check_intent' } },
      extraKwargs: { temperature: 0 },
    });

    for await (const chunk of stream) {
      if (!chunk.delta) continue;

      if (chunk.delta.toolCalls && chunk.delta.toolCalls.length > 0) {
        const toolCall = chunk.delta.toolCalls[0]!;
        if (toolCall.args) {
          try {
            toolArgs = JSON.parse(toolCall.args);
          } catch {
            // Args might be streamed incrementally, keep the last valid parse
          }
        }
      }
    }

    if (!toolArgs) {
      this._raise('LLM did not return any arguments for evaluation.');
    }

    const { success, reason } = toolArgs;

    if (!success) {
      this._raise(`Judgment failed: ${reason}`);
    } else if (evalsVerbose) {
      const printMsg =
        msgContent.length > 30 ? msgContent.slice(0, 30).replace(/\n/g, '\\n') + '...' : msgContent;
      console.log(`- Judgment succeeded for \`${printMsg}\`: \`${reason}\``);
    }

    return this;
  }
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

// TODO: mockTools() utility for mocking tool implementations in tests
// Will be implemented for test suites.
// See Python run_result.py lines 1010-1031 for reference.

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
