// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { ChatContext } from '../llm/chat_context.js';
import type { ToolContext } from '../llm/tool_context.js';
import type { SpeechHandle } from './speech_handle.js';

/**
 * Observe committed turns and control their replies.
 *
 * Hooks returned at user-turn commit stay bound to that turn until reply
 * processing finishes, even if they detach while the customer hook runs.
 *
 * Preemptive generation only calls {@link TurnHooks.onReplyGeneration} until its reply
 * handle is accepted for output.
 *
 * @internal
 */
export interface TurnHooks {
  /** Temporary realtime instructions, available after `shouldReply` allows a reply. */
  readonly replyInstructions: string | undefined;

  /**
   * Bind hooks to the accepted user turn before the customer hook runs.
   * Useful for per-turn classification task.
   */
  onUserTurnCommitted(transcript: string, endOfTurnDelay: number | undefined): TurnHooks;

  /**
   * Observe completion of user-turn processing, including cancellation.
   * Useful for per-turn idle tracking (non-human), unlike user away timeout (human).
   */
  onUserTurnCompleted(): void;

  /**
   * Prepare tools for reply generation, including preemptive and manual replies.
   * Useful for injecting the DTMF tool.
   */
  onReplyGeneration(tools: ToolContext): ToolContext;

  /**
   * Wait for permission to reply and optionally update the reply context.
   * Useful for waiting through advertisement.
   */
  shouldReply(chatCtx: ChatContext): Promise<boolean>;

  /**
   * Observe the agent's reply handle after it is created or adopted for output.
   * Useful for voicemail playout tracking.
   */
  onAgentTurnCommitted(handle: SpeechHandle): void;
}
