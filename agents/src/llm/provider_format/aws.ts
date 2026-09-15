// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { ChatContext, ChatItem, ImageContent } from '../chat_context.js';
import { isInstructions } from '../chat_context.js';
import { type SerializedImage, serializeImage } from '../utils.js';
import { convertMidConversationInstructions, groupToolCalls } from './utils.js';

const AWS_IMAGE_FORMATS: Record<string, string> = {
  'image/jpeg': 'jpeg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

export interface BedrockFormatData {
  systemMessages: string[];
}

export async function toChatCtx(
  chatCtx: ChatContext,
  injectDummyUserMessage: boolean = true,
): Promise<[Record<string, unknown>[], BedrockFormatData]> {
  chatCtx = convertMidConversationInstructions(chatCtx);

  const messages: Record<string, unknown>[] = [];
  const systemMessages: string[] = [];
  let currentRole: string | null = null;
  let currentContent: Record<string, unknown>[] = [];

  const flattenedItems: ChatItem[] = [];
  for (const group of groupToolCalls(chatCtx)) {
    flattenedItems.push(...group.flatten());
  }

  for (const msg of flattenedItems) {
    if (msg.type === 'message' && msg.role === 'system' && msg.textContent) {
      systemMessages.push(msg.textContent);
      continue;
    }

    let role: string;
    if (msg.type === 'message') {
      role = msg.role === 'assistant' ? 'assistant' : 'user';
    } else if (msg.type === 'function_call') {
      role = 'assistant';
    } else if (msg.type === 'function_call_output') {
      role = 'user';
    } else {
      continue;
    }

    if (role !== currentRole) {
      if (currentRole !== null && currentContent.length > 0) {
        messages.push({ role: currentRole, content: currentContent });
      }
      currentContent = [];
      currentRole = role;
    }

    if (msg.type === 'message') {
      for (const content of msg.content) {
        if (content && typeof content === 'string') {
          currentContent.push({ text: content });
        } else if (isInstructions(content)) {
          currentContent.push({ text: content.value });
        } else if (content && typeof content === 'object' && content.type === 'image_content') {
          currentContent.push(await buildImage(content));
        }
      }
    } else if (msg.type === 'function_call') {
      currentContent.push({
        toolUse: {
          toolUseId: msg.callId,
          name: msg.name,
          input: JSON.parse(msg.args || '{}'),
        },
      });
    } else if (msg.type === 'function_call_output') {
      currentContent.push({
        toolResult: {
          toolUseId: msg.callId,
          content: [{ text: msg.output }],
          status: 'success',
        },
      });
    }
  }

  if (currentRole !== null && currentContent.length > 0) {
    messages.push({ role: currentRole, content: currentContent });
  }

  if (injectDummyUserMessage && (messages.length === 0 || messages[0]?.role !== 'user')) {
    messages.unshift({ role: 'user', content: [{ text: '(empty)' }] });
  }

  return [messages, { systemMessages }];
}

async function buildImage(image: ImageContent): Promise<Record<string, unknown>> {
  const cacheKey = 'serialized_image';
  let img: SerializedImage;

  if (image._cache[cacheKey] === undefined) {
    img = await serializeImage(image);
    image._cache[cacheKey] = img;
  }
  img = image._cache[cacheKey];

  if (img.externalUrl) {
    throw new Error('externalUrl is not supported by AWS Bedrock.');
  }
  if (img.base64Data === undefined) {
    throw new Error('Serialized image has no data bytes');
  }

  return {
    image: {
      format: imageFormat(img.mimeType),
      source: { bytes: Buffer.from(img.base64Data, 'base64') },
    },
  };
}

function imageFormat(mimeType: string | undefined): string {
  if (!mimeType) {
    return 'jpeg';
  }

  const format = AWS_IMAGE_FORMATS[mimeType];
  if (format === undefined) {
    throw new Error(`Unsupported mimeType ${mimeType} for AWS Bedrock images`);
  }
  return format;
}
