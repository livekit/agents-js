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

type TurnContentKind = 'conversation' | 'tool_result';

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
  let currentContentKind: TurnContentKind | null = null;
  let content: Record<string, unknown>[] = [];

  const flushTurn = () => {
    if (currentRole !== null && content.length > 0) {
      messages.push({ role: currentRole, content: [...content] });
    }
    content = [];
  };

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
      if (msg.textContent?.trim()) {
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

    const nextContent: Record<string, unknown>[] = [];
    const contentKind: TurnContentKind =
      msg.type === 'function_call_output' ? 'tool_result' : 'conversation';

    if (msg.type === 'message') {
      nextContent.push(...reasoningContentFromExtra(msg.extra));
      for (const part of msg.content) {
        if (typeof part === 'string') {
          if (part.trim()) nextContent.push({ text: part });
        } else if (isInstructions(part)) {
          if (part.value.trim()) nextContent.push({ text: part.value });
        } else if (
          role === 'user' &&
          part &&
          typeof part === 'object' &&
          part.type === 'image_content'
        ) {
          // Bedrock Converse only accepts image blocks in user messages.
          nextContent.push(await toImagePart(part));
        }
        // audio_content is intentionally skipped — Bedrock Converse has no raw audio block
      }
    } else if (msg.type === 'function_call') {
      nextContent.push(...reasoningContentFromExtra(msg.extra));
      nextContent.push({
        toolUse: {
          toolUseId: msg.callId,
          name: msg.name,
          input: JSON.parse(msg.args || '{}'),
        },
      });
    } else if (msg.type === 'function_call_output') {
      nextContent.push({
        toolResult: {
          toolUseId: msg.callId,
          content: [{ text: msg.output.trim() ? msg.output : '(empty)' }],
          status: msg.isError ? 'error' : 'success',
        },
      });
    }

    // Do not let a skipped/empty item switch the active role. Doing so can split two real
    // same-role messages into adjacent turns that Bedrock-hosted models reject.
    if (nextContent.length === 0) continue;

    // Bedrock rejects tool-result and conversation blocks in the same turn. Some hosted models
    // also reject consecutive same-role turns, so bridge a same-role content-kind boundary with
    // the smallest non-empty opposite-role turn rather than either mixing or emitting adjacent
    // user turns.
    if (role === currentRole && contentKind !== currentContentKind) {
      flushTurn();
      messages.push({
        role: role === 'user' ? 'assistant' : 'user',
        content: [{ text: '.' }],
      });
      currentContentKind = contentKind;
    } else if (role !== currentRole) {
      flushTurn();
      currentRole = role;
      currentContentKind = contentKind;
    }
    content.push(...nextContent);
  }

  // Finalize the last turn
  flushTurn();

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

function reasoningContentFromExtra(extra: Record<string, unknown>): Record<string, unknown>[] {
  const aws = extra.aws;
  if (!aws || typeof aws !== 'object' || Array.isArray(aws)) return [];

  const reasoningContent = (aws as Record<string, unknown>).reasoningContent;
  if (!Array.isArray(reasoningContent)) return [];

  const blocks: Record<string, unknown>[] = [];
  for (const value of reasoningContent) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const block = value as Record<string, unknown>;
    const reasoningText = block.reasoningText;
    if (reasoningText && typeof reasoningText === 'object' && !Array.isArray(reasoningText)) {
      const textBlock = reasoningText as Record<string, unknown>;
      if (typeof textBlock.text !== 'string') continue;
      blocks.push({
        reasoningContent: {
          reasoningText: {
            text: textBlock.text,
            ...(typeof textBlock.signature === 'string' ? { signature: textBlock.signature } : {}),
          },
        },
      });
      continue;
    }

    if (typeof block.redactedContent === 'string') {
      blocks.push({
        reasoningContent: {
          redactedContent: Buffer.from(block.redactedContent, 'base64'),
        },
      });
    }
  }
  return blocks;
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

  const bytesCacheKey = 'aws_image_bytes';
  if (!image._cache[bytesCacheKey]) {
    image._cache[bytesCacheKey] = Buffer.from(img.base64Data ?? '', 'base64');
  }

  return {
    image: {
      format: imageFormat(img.mimeType),
      source: { bytes: image._cache[bytesCacheKey] },
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
