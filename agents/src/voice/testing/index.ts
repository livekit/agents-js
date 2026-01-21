// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Testing utilities for agent evaluation.
 *
 * @example
 * ```typescript
 * import { AgentSession, Agent, voice } from '@livekit/agents';
 *
 * const session = new AgentSession({ llm });
 * await session.start(agent);
 *
 * const result = await session.run({ userInput: 'Hello' });
 * result.expect.nextEvent().isMessage({ role: 'assistant' });
 * result.expect.noMoreEvents();
 * ```
 *
 * @packageDocumentation
 */

export {
  AgentHandoffAssert,
  AssertionError,
  EventAssert,
  EventRangeAssert,
  FunctionCallAssert,
  FunctionCallOutputAssert,
  MessageAssert,
  RunAssert,
  RunResult,
} from './run_result.js';

export {
  isAgentHandoffEvent,
  isChatMessageEvent,
  isFunctionCallEvent,
  isFunctionCallOutputEvent,
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
} from './types.js';
