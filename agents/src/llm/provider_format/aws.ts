// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { ChatContext, ChatItem, ImageContent } from '../chat_context.js';
import { isInstructions } from '../chat_context.js';
import { type SerializedImage, serializeImage } from '../utils.js';
import { convertMidConversationInstructions, groupToolCalls } from './utils.js';

export interface AwsFormatData {
  systemMessages: string[] | null;
}

const AWS_IMAGE_FORMATS: Record<string, string> = {
  'image/jpeg': 'jpeg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

/**
 * Convert a LiveKit ChatContext into AWS Bedrock Converse API message entries.
 *
 * - System messages are extracted separately (Bedrock takes `system` outside `messages`).
 * - `function_call` items become assistant `toolUse` content blocks.
 * - `function_call_output` items become user `toolResult` content blocks.
 * - Consecutive same-role turns are merged (Bedrock requires strictly alternating roles).
 * - A dummy user message is inserted at the front if the conversation doesn't start with one.
 */
export async function toChatCtx(
  chatCtx: ChatContext,
  injectDummyUserMessage: boolean = true,
): Promise<[Record<string, unknown>[], AwsFormatData]> {
  chatCtx = convertMidConversationInstructions(chatCtx);

  const messages: Record<string, unknown>[] = [];
  const systemMessages: string[] = [];
  let currentRole: string | null = null;
  let content: Record<string, unknown>[] = [];

  const itemGroups = groupToolCalls(chatCtx);
  const flattenedItems: ChatItem[] = [];
  for (const group of itemGroups) {
    flattenedItems.push(...group.flatten());
  }

  for (const msg of flattenedItems) {
    if (msg.type === 'message' && (msg.role === 'system' || msg.role === 'developer')) {
      // Always exclude system/developer messages from the regular role mapping below, even
      // when they carry no usable text (e.g. image-only content) — they must never be
      // reattributed to the user/assistant turn merge.
      if (msg.textContent) {
        systemMessages.push(msg.textContent);
      }
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
      continue; // Skip unknown message types (e.g. agent_handoff, agent_config_update)
    }

    // If the effective role changed, finalize the previous turn
    if (role !== currentRole) {
      if (currentRole !== null && content.length > 0) {
        messages.push({ role: currentRole, content: [...content] });
      }
      content = [];
      currentRole = role;
    }

    if (msg.type === 'message') {
      for (const part of msg.content) {
        if (typeof part === 'string') {
          content.push({ text: part });
        } else if (isInstructions(part)) {
          content.push({ text: part.value });
        } else if (part && typeof part === 'object' && part.type === 'image_content') {
          content.push(await toImagePart(part));
        }
        // audio_content is intentionally skipped — Bedrock Converse has no raw audio block
      }
    } else if (msg.type === 'function_call') {
      content.push({
        toolUse: {
          toolUseId: msg.callId,
          name: msg.name,
          input: JSON.parse(msg.args || '{}'),
        },
      });
    } else if (msg.type === 'function_call_output') {
      content.push({
        toolResult: {
          toolUseId: msg.callId,
          content: [{ text: msg.output }],
          status: msg.isError ? 'error' : 'success',
        },
      });
    }
  }

  // Finalize the last turn
  if (currentRole !== null && content.length > 0) {
    messages.push({ role: currentRole, content });
  }

  // Bedrock requires the message list to start with a "user" turn
  if (injectDummyUserMessage && (messages.length === 0 || messages[0]!.role !== 'user')) {
    messages.unshift({ role: 'user', content: [{ text: '(empty)' }] });
  }

  // Some Bedrock-hosted models (e.g. Anthropic Claude) reject a request ending on an
  // assistant turn, or silently treat it as a prefill continuation instead of generating a
  // fresh reply.
  if (
    injectDummyUserMessage &&
    messages.length > 0 &&
    messages[messages.length - 1]!.role === 'assistant'
  ) {
    messages.push({ role: 'user', content: [{ text: '.' }] });
  }

  return [
    messages,
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
    throw new Error(
      'externalUrl images are not supported by AWS Bedrock, provide inline image data instead',
    );
  }

  return {
    image: {
      format: imageFormat(img.mimeType),
      source: { bytes: Buffer.from(img.base64Data ?? '', 'base64') },
    },
  };
}

function imageFormat(mimeType?: string): string {
  if (!mimeType) return 'jpeg';

  const format = AWS_IMAGE_FORMATS[mimeType];
  if (!format) {
    throw new Error(
      `Unsupported mimeType ${mimeType} for AWS Bedrock images. Must be jpeg, png, webp, or gif`,
    );
  }
  return format;
}
