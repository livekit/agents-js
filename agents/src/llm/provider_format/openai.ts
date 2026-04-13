// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { ChatContext, ChatItem, ImageContent } from '../chat_context.js';
import { type SerializedImage, serializeImage } from '../utils.js';
import { groupToolCalls } from './utils.js';

const EXTRA_CONTENT_KEYS = ['google', 'livekit', 'xai'] as const;

function filterExtra(extra: Record<string, unknown>): Record<string, unknown> {
  const filtered: Record<string, unknown> = {};
  for (const key of EXTRA_CONTENT_KEYS) {
    if (extra[key]) {
      filtered[key] = extra[key];
    }
  }
  return filtered;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function toChatCtx(chatCtx: ChatContext, injectDummyUserMessage: boolean = true) {
  const itemGroups = groupToolCalls(chatCtx);
  const messages: Record<string, any>[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any

  for (const group of itemGroups) {
    if (group.isEmpty) continue;

    const message: Record<string, any> = group.message // eslint-disable-line @typescript-eslint/no-explicit-any
      ? await toChatItem(group.message)
      : { role: 'assistant' };

    const toolCalls = group.toolCalls.map((toolCall) => {
      const tc: Record<string, any> = {
        type: 'function',
        id: toolCall.callId,
        function: { name: toolCall.name, arguments: toolCall.args },
      };

      const extraContent = toolCall.extra ? filterExtra(toolCall.extra) : {};
      if (!extraContent.google && toolCall.thoughtSignature) {
        extraContent.google = { thoughtSignature: toolCall.thoughtSignature };
      }
      if (Object.keys(extraContent).length > 0) {
        tc.extra_content = extraContent;
      }
      return tc;
    });

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

    const result: Record<string, any> = { role: item.role };
    if (listContent.length === 0) {
      result.content = textContent;
    } else {
      if (textContent.length > 0) {
        listContent.push({ type: 'text', text: textContent });
      }
      result.content = listContent;
    }

    if (item.extra) {
      const extraContent = filterExtra(item.extra);
      if (Object.keys(extraContent).length > 0) {
        result.extra_content = extraContent;
      }
    }

    return result;
  } else if (item.type === 'function_call') {
    const tc: Record<string, any> = {
      id: item.callId,
      type: 'function',
      function: { name: item.name, arguments: item.args },
    };

    const extraContent = item.extra ? filterExtra(item.extra) : {};
    if (!extraContent.google && item.thoughtSignature) {
      extraContent.google = { thoughtSignature: item.thoughtSignature };
    }
    if (Object.keys(extraContent).length > 0) {
      tc.extra_content = extraContent;
    }

    return {
      role: 'assistant',
      tool_calls: [tc],
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

async function toResponsesImageContent(content: ImageContent) {
  const cacheKey = 'serialized_image';
  let serialized: SerializedImage;

  if (content._cache[cacheKey] === undefined) {
    serialized = await serializeImage(content);
    content._cache[cacheKey] = serialized;
  }
  serialized = content._cache[cacheKey];

  if (serialized.externalUrl) {
    return {
      type: 'input_image' as const,
      image_url: serialized.externalUrl,
      detail: serialized.inferenceDetail,
    };
  }

  if (serialized.base64Data === undefined) {
    throw new Error('Serialized image has no data bytes');
  }

  return {
    type: 'input_image' as const,
    image_url: `data:${serialized.mimeType};base64,${serialized.base64Data}`,
    detail: serialized.inferenceDetail,
  };
}

export async function toResponsesChatCtx(
  chatCtx: ChatContext,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  injectDummyUserMessage: boolean = true,
) {
  const itemGroups = groupToolCalls(chatCtx);
  const messages: Record<string, any>[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any

  for (const group of itemGroups) {
    if (group.isEmpty) continue;

    if (group.message) {
      messages.push(await toResponsesChatItem(group.message));
    }

    for (const toolCall of group.toolCalls) {
      messages.push({
        type: 'function_call',
        call_id: toolCall.callId,
        name: toolCall.name,
        arguments: toolCall.args,
      });
    }

    for (const toolOutput of group.toolOutputs) {
      messages.push(await toResponsesChatItem(toolOutput));
    }
  }

  return messages;
}

async function toResponsesChatItem(item: ChatItem) {
  if (item.type === 'message') {
    const listContent: Record<string, any>[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
    let textContent = '';

    for (const content of item.content) {
      if (typeof content === 'string') {
        if (textContent) textContent += '\n';
        textContent += content;
      } else if (content.type === 'image_content') {
        listContent.push(await toResponsesImageContent(content));
      } else {
        throw new Error(`Unsupported content type: ${content.type}`);
      }
    }

    const content =
      listContent.length == 0
        ? textContent
        : textContent.length == 0
          ? listContent
          : [...listContent, { type: 'input_text', text: textContent }];

    return { role: item.role, content };
  } else if (item.type === 'function_call') {
    return {
      type: 'function_call',
      call_id: item.callId,
      name: item.name,
      arguments: item.args,
    };
  } else if (item.type === 'function_call_output') {
    return {
      type: 'function_call_output',
      call_id: item.callId,
      output: item.output,
    };
  }

  throw new Error(`Unsupported item type: ${item['type']}`);
}
