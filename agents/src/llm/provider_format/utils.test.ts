// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { ChatContext, ChatMessage } from '../chat_context.js';
import { groupToolCalls } from './utils.js';

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
