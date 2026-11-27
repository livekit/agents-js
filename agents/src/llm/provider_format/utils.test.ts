// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { ChatContext, ChatMessage } from '../chat_context.js';
import { convertMidConversationInstructions, groupToolCalls } from './utils.js';

describe('groupToolCalls', () => {
  it('preserves insertion order for non-assistant message groups', () => {
    const chatCtx = new ChatContext([
      ChatMessage.create({
        id: '10',
        role: 'user',
        content: 'first',
      }),
      ChatMessage.create({
        id: '2',
        role: 'system',
        content: 'second',
      }),
    ]);

    const groups = groupToolCalls(chatCtx);
    const itemIds = groups.map((group) => group.flatten()[0]!.id);

    expect(itemIds).toEqual(['10', '2']);
  });
});

describe('convertMidConversationInstructions', () => {
  it('keeps dollar signs in the instructions as written', () => {
    const chatCtx = new ChatContext([
      ChatMessage.create({ id: 'sys', role: 'system', content: 'You are a helpful assistant.' }),
      ChatMessage.create({ id: 'u1', role: 'user', content: 'Find me a restaurant.' }),
      ChatMessage.create({
        id: 'sys2',
        role: 'system',
        content: "Only suggest $$ or $$$ places, never $& or $' ones.",
      }),
    ]);

    const converted = convertMidConversationInstructions(chatCtx);
    const last = converted.items.at(-1) as ChatMessage;

    expect(last.role).toBe('user');
    expect(last.textContent).toBe(
      "New instructions received. Apply them carefully: Only suggest $$ or $$$ places, never $& or $' ones.",
    );
  });
});
