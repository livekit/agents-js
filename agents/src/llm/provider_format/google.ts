// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { ChatContext, ChatItem, ImageContent } from '../chat_context.js';
import { type SerializedImage, serializeImage } from '../utils.js';
import { groupToolCalls } from './utils.js';

export interface GoogleFormatData {
  systemMessages: string[] | null;
}

export async function toChatCtx(
  chatCtx: ChatContext,
  injectDummyUserMessage: boolean = true,
): Promise<[Record<string, unknown>[], GoogleFormatData]> {
  const turns: Record<string, unknown>[] = [];
  const systemMessages: string[] = [];
  let currentRole: string | null = null;
  let parts: Record<string, unknown>[] = [];

  // Flatten all grouped tool calls to get individual messages
  const itemGroups = groupToolCalls(chatCtx);
  const flattenedItems: ChatItem[] = [];

  for (const group of itemGroups) {
    flattenedItems.push(...group.flatten());
  }

  for (const msg of flattenedItems) {
    // Handle system messages separately
    if (msg.type === 'message' && msg.role === 'system' && msg.textContent) {
      systemMessages.push(msg.textContent);
      continue;
    }

    let role: string;
    if (msg.type === 'message') {
      role = msg.role === 'assistant' ? 'model' : 'user';
    } else if (msg.type === 'function_call') {
      role = 'model';
    } else if (msg.type === 'function_call_output') {
      role = 'user';
    } else {
      continue; // Skip unknown message types
    }

    // If the effective role changed, finalize the previous turn
    if (role !== currentRole) {
      if (currentRole !== null && parts.length > 0) {
        turns.push({ role: currentRole, parts: [...parts] });
      }
      parts = [];
      currentRole = role;
    }

    if (msg.type === 'message') {
      for (const content of msg.content) {
        if (content && typeof content === 'string') {
          parts.push({ text: content });
        } else if (content && typeof content === 'object') {
          if (content.type === 'image_content') {
            parts.push(await toImagePart(content));
          } else {
            // Handle other content types as JSON
            parts.push({ text: JSON.stringify(content) });
          }
        }
      }
    } else if (msg.type === 'function_call') {
      parts.push({
        functionCall: {
          id: msg.callId,
          name: msg.name,
          args: JSON.parse(msg.args || '{}'),
        },
      });
    } else if (msg.type === 'function_call_output') {
      const response = msg.isError ? { error: msg.output } : { output: msg.output };
      parts.push({
        functionResponse: {
          id: msg.callId,
          name: msg.name,
          response,
        },
      });
    }
  }

  // Finalize the last turn
  if (currentRole !== null && parts.length > 0) {
    turns.push({ role: currentRole, parts });
  }

  // Gemini requires the last message to end with user's turn before they can generate
  if (injectDummyUserMessage && currentRole !== 'user') {
    turns.push({ role: 'user', parts: [{ text: '.' }] });
  }

  return [
    turns,
    {
      systemMessages: systemMessages.length > 0 ? systemMessages : null,
    },
  ];
}

async function toImagePart(image: ImageContent): Promise<Record<string, unknown>> {
  const cacheKey = 'serialized_image';
  if (!image._cache[cacheKey]) {
    image._cache[cacheKey] = await serializeImage(image);
  }
  const img: SerializedImage = image._cache[cacheKey];

  if (img.externalUrl) {
    const mimeType = img.mimeType || 'image/jpeg';
    return {
      fileData: {
        fileUri: img.externalUrl,
        mimeType,
      },
    };
  }

  return {
    inlineData: {
      data: img.base64Data,
      mimeType: img.mimeType,
    },
  };
}
