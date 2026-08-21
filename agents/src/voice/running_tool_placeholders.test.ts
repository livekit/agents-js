// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { ChatContext, ChatMessage, FunctionCall } from '../llm/chat_context.js';
import { _injectRunningToolCalls, _stripRunningToolCalls } from './generation.js';

describe('running tool placeholders', () => {
  it('adds a valid in-progress pair for a running call missing from the LLM context', () => {
    const chatCtx = ChatContext.empty();
    const running = FunctionCall.create({
      callId: 'call_1',
      name: 'book_flight',
      args: '{}',
    });

    _injectRunningToolCalls(chatCtx, [running]);

    expect(
      chatCtx.items.filter(
        (item) => item.type === 'function_call' && item.callId === running.callId,
      ),
    ).toHaveLength(1);
    expect(
      chatCtx.items.filter(
        (item) => item.type === 'function_call_output' && item.callId === running.callId,
      ),
    ).toHaveLength(1);
  });

  it('adds only the missing output when the running call is already in context', () => {
    const running = FunctionCall.create({
      callId: 'call_orphan',
      name: 'charge_card',
      args: '{}',
    });
    const chatCtx = new ChatContext([running]);

    _injectRunningToolCalls(chatCtx, [running]);

    expect(
      chatCtx.items.filter(
        (item) => item.type === 'function_call' && item.callId === running.callId,
      ),
    ).toHaveLength(1);
    expect(
      chatCtx.items.filter(
        (item) => item.type === 'function_call_output' && item.callId === running.callId,
      ),
    ).toHaveLength(1);
  });

  it('strips only ephemeral items while preserving an original orphan call and custom edits', () => {
    const orphan = FunctionCall.create({
      callId: 'call_orphan',
      name: 'charge_card',
      args: '{}',
    });
    const fullyMissing = FunctionCall.create({
      callId: 'call_missing',
      name: 'send_email',
      args: '{}',
    });
    const custom = ChatMessage.create({ role: 'system', content: 'custom llm node context' });
    const chatCtx = new ChatContext([orphan]);

    _injectRunningToolCalls(chatCtx, [orphan, fullyMissing]);
    chatCtx.insert(custom);
    _stripRunningToolCalls(chatCtx);

    expect(chatCtx.items).toContain(orphan);
    expect(chatCtx.items).toContain(custom);
    expect(chatCtx.items.some((item) => item.type === 'function_call_output')).toBe(false);
    expect(
      chatCtx.items.some(
        (item) => item.type === 'function_call' && item.callId === fullyMissing.callId,
      ),
    ).toBe(false);
  });
});
