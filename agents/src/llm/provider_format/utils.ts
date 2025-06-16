// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { log } from '../../log.js';
import type {
  ChatContext,
  ChatItem,
  ChatMessage,
  FunctionCall,
  FunctionCallOutput,
} from '../chat_context.js';

class ChatItemGroup {
  message?: ChatMessage;
  toolCalls: FunctionCall[];
  toolOutputs: FunctionCallOutput[];
  logger = log();

  constructor(params: {
    message?: ChatMessage;
    toolCalls: FunctionCall[];
    toolOutputs: FunctionCallOutput[];
  }) {
    this.message = params.message;
    this.toolCalls = params.toolCalls;
    this.toolOutputs = params.toolOutputs;
  }

  static create(params?: {
    message?: ChatMessage;
    toolCalls?: FunctionCall[];
    toolOutputs?: FunctionCallOutput[];
  }) {
    const { message, toolCalls = [], toolOutputs = [] } = params ?? {};
    return new ChatItemGroup({ message, toolCalls, toolOutputs });
  }

  get isEmpty() {
    return (
      this.message === undefined && this.toolCalls.length === 0 && this.toolOutputs.length === 0
    );
  }

  add(item: ChatItem) {
    if (item.type === 'message') {
      if (this.message) {
        throw new Error('only one message is allowed in a group');
      }
      this.message = item;
    } else if (item.type === 'function_call') {
      this.toolCalls.push(item);
    } else if (item.type === 'function_call_output') {
      this.toolOutputs.push(item);
    }
    return this;
  }

  removeInvalidToolCalls() {
    if (this.toolCalls.length === this.toolOutputs.length) {
      return;
    }

    const toolCallIds = new Set(this.toolCalls.map((call) => call.callId));
    const toolOutputIds = new Set(this.toolOutputs.map((output) => output.callId));

    // intersection of tool call ids and tool output ids
    const validCallIds = intersection(toolCallIds, toolOutputIds);

    // filter out tool calls that don't have a corresponding tool output
    this.toolCalls = this.toolCalls.filter((call) => {
      if (validCallIds.has(call.callId)) return true;
      this.logger.warn(
        {
          callId: call.callId,
          toolName: call.name,
        },
        'function call missing the corresponding function output, ignoring',
      );
      return false;
    });

    // filter out tool outputs that don't have a corresponding tool call
    this.toolOutputs = this.toolOutputs.filter((output) => {
      if (validCallIds.has(output.callId)) return true;
      this.logger.warn(
        {
          callId: output.callId,
          toolName: output.name,
        },
        'function output missing the corresponding function call, ignoring',
      );
      return false;
    });
  }

  flatten() {
    const items: ChatItem[] = [];
    if (this.message) items.push(this.message);
    items.push(...this.toolCalls, ...this.toolOutputs);
    return items;
  }
}

function intersection<T>(set1: Set<T>, set2: Set<T>): Set<T> {
  return new Set([...set1].filter((item) => set2.has(item)));
}

/**
 * Group chat items (messages, function calls, and function outputs)
 * into coherent groups based on their item IDs and call IDs.
 *
 * Each group will contain:
 * - Zero or one assistant message
 * - Zero or more function/tool calls
 * - The corresponding function/tool outputs matched by call_id
 *
 * User and system messages are placed in their own individual groups.
 *
 * @param chatCtx - The chat context containing all conversation items
 * @returns A list of ChatItemGroup objects representing the grouped conversation
 */
export function groupToolCalls(chatCtx: ChatContext) {
  const itemGroups: Record<string, ChatItemGroup> = {};
  const insertionOrder: Record<string, number> = {};
  const toolOutputs: FunctionCallOutput[] = [];
  const logger = log();

  let insertionIndex = 0;
  for (const item of chatCtx.items) {
    const isAssistantMessage = item.type === 'message' && item.role === 'assistant';
    const isFunctionCall = item.type === 'function_call';
    const isFunctionCallOutput = item.type === 'function_call_output';

    if (isAssistantMessage || isFunctionCall) {
      // only assistant messages and function calls can be grouped
      const groupId = item.id.split('/')[0]!;
      if (itemGroups[groupId] === undefined) {
        itemGroups[groupId] = ChatItemGroup.create();

        // we use insertion order to sort the groups as they are added to the context
        // simulating the OrderedDict in python
        insertionOrder[groupId] = insertionIndex;
        insertionIndex++;
      }
      itemGroups[groupId]!.add(item);
    } else if (isFunctionCallOutput) {
      toolOutputs.push(item);
    } else {
      itemGroups[item.id] = ChatItemGroup.create().add(item);
    }
  }

  // add tool outputs to their corresponding groups
  const callIdToGroup: Record<string, ChatItemGroup> = {};
  for (const group of Object.values(itemGroups)) {
    for (const toolCall of group.toolCalls) {
      callIdToGroup[toolCall.callId] = group;
    }
  }

  for (const toolOutput of toolOutputs) {
    const group = callIdToGroup[toolOutput.callId];
    if (group === undefined) {
      logger.warn(
        { callId: toolOutput.callId, toolName: toolOutput.name },
        'function output missing the corresponding function call, ignoring',
      );
      continue;
    }
    group.add(toolOutput);
  }

  // validate that each group and remove invalid tool calls and tool outputs
  for (const group of Object.values(itemGroups)) {
    group.removeInvalidToolCalls();
  }

  // sort groups by their item id
  const orderedGroups = Object.entries(itemGroups)
    .sort((a, b) => insertionOrder[a[0]]! - insertionOrder[b[0]]!)
    .map(([, group]) => group);
  return orderedGroups;
}
