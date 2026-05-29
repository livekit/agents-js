// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { ChatContext } from '../chat_context.js';
import type { GoogleFormatData } from './google.js';
import { toChatCtx as toChatCtxGoogle } from './google.js';
import type { MistralFormatData } from './mistralai.js';
import { toChatCtx as toChatCtxMistralai } from './mistralai.js';
import {
  toChatCtx as toChatCtxOpenai,
  toResponsesChatCtx as toResponsesChatCtxOpenai,
} from './openai.js';

export type ProviderFormat = 'openai' | 'openai.responses' | 'google' | 'mistralai';

export async function toChatCtx(
  format: ProviderFormat,
  chatCtx: ChatContext,
  injectDummyUserMessage: boolean = true,
): Promise<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  | Record<string, any>[]
  | [Record<string, unknown>[], GoogleFormatData]
  | [Record<string, unknown>[], MistralFormatData]
> {
  switch (format) {
    case 'openai':
      return await toChatCtxOpenai(chatCtx, injectDummyUserMessage);
    case 'openai.responses':
      return await toResponsesChatCtxOpenai(chatCtx, injectDummyUserMessage);
    case 'google':
      return await toChatCtxGoogle(chatCtx, injectDummyUserMessage);
    case 'mistralai':
      return toChatCtxMistralai(chatCtx, injectDummyUserMessage);
    default:
      throw new Error(`Unsupported provider format: ${format}`);
  }
}
