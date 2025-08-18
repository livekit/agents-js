// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { ChatContext } from '../chat_context.js';
import { toChatCtx as toChatCtxGoogle } from './google.js';
import { toChatCtx as toChatCtxOpenai } from './openai.js';

export type ProviderFormat = 'openai' | 'google';

export async function toChatCtx(
  format: ProviderFormat,
  chatCtx: ChatContext,
  injectDummyUserMessage: boolean = true,
) {
  switch (format) {
    case 'openai':
      return await toChatCtxOpenai(chatCtx, injectDummyUserMessage);
    case 'google':
      return await toChatCtxGoogle(chatCtx, injectDummyUserMessage);
    default:
      throw new Error(`Unsupported provider format: ${format}`);
  }
}
