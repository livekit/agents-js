// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { ChatContext } from '../chat_context.js';

export interface MistralFormatData {
  instructions: string;
}

/**
 * Convert a LiveKit ChatContext into Mistral Conversations API entries.
 *
 * - System/developer messages are extracted as `instructions` (passed separately).
 * - User messages become `MessageInputEntry` items (`message.input`, role `user`).
 * - Assistant messages become `MessageOutputEntry` items (`message.output`, role `assistant`).
 * - Function calls become `FunctionCallEntry` items (`function.call`).
 * - Function call outputs become `FunctionResultEntry` items (`function.result`).
 * - If entries would be empty (e.g. only system messages), a dummy user message is injected
 *   so the API has a non-empty `inputs` array.
 */
export function toChatCtx(
  chatCtx: ChatContext,
  injectDummyUserMessage: boolean = true,
): [Record<string, unknown>[], MistralFormatData] {
  const entries: Record<string, unknown>[] = [];
  const instructionParts: string[] = [];

  for (const item of chatCtx.items) {
    if (item.type === 'message') {
      const text = item.content.filter((c): c is string => typeof c === 'string').join('\n');

      if (item.role === 'system' || item.role === 'developer') {
        instructionParts.push(text);
      } else if (item.role === 'user') {
        entries.push({ type: 'message.input', role: 'user', content: text });
      } else if (item.role === 'assistant') {
        entries.push({ type: 'message.output', role: 'assistant', content: text });
      }
    } else if (item.type === 'function_call') {
      entries.push({
        type: 'function.call',
        toolCallId: item.callId,
        name: item.name,
        arguments: item.args,
      });
    } else if (item.type === 'function_call_output') {
      entries.push({
        type: 'function.result',
        toolCallId: item.callId,
        result: item.output,
      });
    }
  }

  if (entries.length === 0 && injectDummyUserMessage) {
    entries.push({ type: 'message.input', role: 'user', content: '.' });
  }

  return [entries, { instructions: instructionParts.join('\n') }];
}
