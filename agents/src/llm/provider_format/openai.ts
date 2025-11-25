// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { ChatContext, ChatItem, ImageContent } from '../chat_context.js';
import { type SerializedImage, serializeImage } from '../utils.js';
import { groupToolCalls } from './utils.js';

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function toChatCtx(chatCtx: ChatContext, injectDummyUserMessage: boolean = true) {
  const itemGroups = groupToolCalls(chatCtx);
  const messages: Record<string, any>[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any

  for (const group of itemGroups) {
    if (group.isEmpty) continue;

    const message: Record<string, any> = group.message // eslint-disable-line @typescript-eslint/no-explicit-any
      ? await toChatItem(group.message)
      : { role: 'assistant' };

    const toolCalls = group.toolCalls.map((toolCall) => ({
      type: 'function',
      id: toolCall.callId,
      function: { name: toolCall.name, arguments: toolCall.args },
    }));

    if (toolCalls.length > 0) {
      message['tool_calls'] = toolCalls;
    }

    messages.push(message);

    for (const toolOutput of group.toolOutputs) {
      messages.push(await toChatItem(toolOutput));
    }
  }

  return messages;
}

async function toChatItem(item: ChatItem) {
  if (item.type === 'message') {
    const listContent: Record<string, any>[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
    let textContent = '';

    for (const content of item.content) {
      if (typeof content === 'string') {
        if (textContent) textContent += '\n';
        textContent += content;
      } else if (content.type === 'image_content') {
        listContent.push(await toImageContent(content));
      } else {
        throw new Error(`Unsupported content type: ${content.type}`);
      }
    }

    const content =
      listContent.length == 0
        ? textContent
        : textContent.length == 0
          ? listContent
          : [...listContent, { type: 'text', text: textContent }];

    return { role: item.role, content };
  } else if (item.type === 'function_call') {
    return {
      role: 'assistant',
      tool_calls: [
        {
          id: item.callId,
          type: 'function',
          function: { name: item.name, arguments: item.args },
        },
      ],
    };
  } else if (item.type === 'function_call_output') {
    return {
      role: 'tool',
      tool_call_id: item.callId,
      content: item.output,
    };
  }
  // Skip other item types (e.g., agent_handoff)
  // These should be filtered by groupToolCalls, but this is a safety net
  throw new Error(`Unsupported item type: ${item['type']}`);
}

async function toImageContent(content: ImageContent) {
  const cacheKey = 'serialized_image'; // TODO: use hash of encoding options if available
  let serialized: SerializedImage;

  if (content._cache[cacheKey] === undefined) {
    serialized = await serializeImage(content);
    content._cache[cacheKey] = serialized;
  }
  serialized = content._cache[cacheKey];

  // Convert SerializedImage to OpenAI format
  if (serialized.externalUrl) {
    return {
      type: 'image_url',
      image_url: {
        url: serialized.externalUrl,
        detail: serialized.inferenceDetail,
      },
    };
  }

  if (serialized.base64Data === undefined) {
    throw new Error('Serialized image has no data bytes');
  }

  return {
    type: 'image_url',
    image_url: {
      url: `data:${serialized.mimeType};base64,${serialized.base64Data}`,
      detail: serialized.inferenceDetail,
    },
  };
}
