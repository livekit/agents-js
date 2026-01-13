// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type {
  AgentHandoffItem,
  ChatMessage,
  ChatRole,
  FunctionCall,
  FunctionCallOutput,
} from '../../llm/chat_context.js';
import type { Agent } from '../agent.js';

/**
 * Event representing an assistant or user message in the conversation.
 */
export interface ChatMessageEvent {
  type: 'message';
  item: ChatMessage;
}

/**
 * Event representing a function/tool call initiated by the LLM.
 */
export interface FunctionCallEvent {
  type: 'function_call';
  item: FunctionCall;
}

/**
 * Event representing the output/result of a function call.
 */
export interface FunctionCallOutputEvent {
  type: 'function_call_output';
  item: FunctionCallOutput;
}

/**
 * Event representing an agent handoff (switching from one agent to another).
 */
export interface AgentHandoffEvent {
  type: 'agent_handoff';
  item: AgentHandoffItem;
  oldAgent?: Agent;
  newAgent: Agent;
}

/**
 * Union type of all possible run events that can occur during a test run.
 */
export type RunEvent =
  | ChatMessageEvent
  | FunctionCallEvent
  | FunctionCallOutputEvent
  | AgentHandoffEvent;

/**
 * Type guard to check if an event is a ChatMessageEvent.
 */
export function isChatMessageEvent(event: RunEvent): event is ChatMessageEvent {
  return event.type === 'message';
}

/**
 * Type guard to check if an event is a FunctionCallEvent.
 */
export function isFunctionCallEvent(event: RunEvent): event is FunctionCallEvent {
  return event.type === 'function_call';
}

/**
 * Type guard to check if an event is a FunctionCallOutputEvent.
 */
export function isFunctionCallOutputEvent(event: RunEvent): event is FunctionCallOutputEvent {
  return event.type === 'function_call_output';
}

/**
 * Type guard to check if an event is an AgentHandoffEvent.
 */
export function isAgentHandoffEvent(event: RunEvent): event is AgentHandoffEvent {
  return event.type === 'agent_handoff';
}

/**
 * Options for message assertion.
 */
export interface MessageAssertOptions {
  role?: ChatRole;
}

/**
 * Options for function call assertion.
 */
export interface FunctionCallAssertOptions {
  name?: string;
  args?: Record<string, unknown>;
}

/**
 * Options for function call output assertion.
 */
export interface FunctionCallOutputAssertOptions {
  output?: string;
  isError?: boolean;
}

/**
 * Options for agent handoff assertion.
 */
export interface AgentHandoffAssertOptions {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  newAgentType?: new (...args: any[]) => Agent;
}

/**
 * Event type literals for type-safe event filtering.
 */
export type EventType = 'message' | 'function_call' | 'function_call_output' | 'agent_handoff';
