// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { initializeLogger, llm } from '@livekit/agents';
import { afterEach, expect, it, vi } from 'vitest';
import { RealtimeModel } from './realtime_model.js';
import { PrismPeer } from './test_helpers.js';

initializeLogger({ pretty: false, level: 'silent' });
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function setup() {
  const peer = await new PrismPeer().start();
  cleanup.push(() => peer.close());
  const model = new RealtimeModel({ endpoint: peer.endpoint, apiKey: 'test', requestTimeout: 300 });
  cleanup.push(() => model.close());
  const session = model.session();
  await session.updateInstructions('Test');
  const ctx = llm.ChatContext.empty();
  ctx.addMessage({ role: 'system', content: 'Context', id: 'system' });
  ctx.addMessage({ role: 'user', content: 'Hello', id: 'user' });
  ctx.addMessage({ role: 'assistant', content: 'Welcome', id: 'assistant' });
  await session.updateChatCtx(ctx);
  return { peer, model, session, ctx };
}

it('keeps independent acknowledged snapshots', async () => {
  const { session, ctx } = await setup();
  (ctx.items[0] as llm.ChatMessage).content[0] = 'Changed externally';
  const copy = session.chatCtx;
  (copy.items[1] as llm.ChatMessage).content[0] = 'Changed snapshot';
  expect((session.chatCtx.items[0] as llm.ChatMessage).textContent).toBe('Context');
  expect((session.chatCtx.items[1] as llm.ChatMessage).textContent).toBe('Hello');
  const history = await session.getHistory();
  expect(history).toHaveLength(3);
});

it('preserves deletion-only edits without recreating surviving turns', async () => {
  const { peer, session } = await setup();
  const ctx = session.chatCtx;
  ctx.remove('user');
  await session.updateChatCtx(ctx);
  expect(peer.requests.filter((q) => q.type === 'conversation.item.create')).toHaveLength(3);
  expect(peer.requests.filter((q) => q.type === 'conversation.item.delete')).toHaveLength(1);
  expect((await session.getHistory()).map((item) => item.type === 'message' && item.text)).toEqual([
    'Context',
    'Welcome',
  ]);
});

it('rebuilds completed history when its order or content changes', async () => {
  const { peer, session } = await setup();
  const ctx = session.chatCtx;
  ctx.items.reverse();
  (ctx.items[0] as llm.ChatMessage).content = ['Revised'];
  await session.updateChatCtx(ctx);
  expect(peer.requests.filter((q) => q.type === 'conversation.item.delete')).toHaveLength(3);
  expect((await session.getHistory()).map((item) => item.type === 'message' && item.text)).toEqual([
    'Revised',
    'Hello',
    'Context',
  ]);
});

it.each(['media', 'long', 'unicode', 'pending', 'orphan', 'duplicate', 'split-tool'])(
  'validates the whole %s edit before mutation',
  async (kind) => {
    const { peer, session } = await setup();
    const ctx = session.chatCtx;
    ctx.addMessage({ role: 'user', content: 'This valid message must not be sent' });
    if (kind === 'media')
      ctx.addMessage({
        role: 'user',
        content: [
          { type: 'image_content', image: 'https://example.com/image.png' } as llm.ImageContent,
        ],
      });
    if (kind === 'long') ctx.addMessage({ role: 'user', content: 'x'.repeat(4001) });
    if (kind === 'unicode') ctx.addMessage({ role: 'user', content: '\ud800' });
    if (kind === 'duplicate') ctx.items.push(ctx.items[0]!);
    if (kind === 'pending' || kind === 'split-tool')
      ctx.items.push(new llm.FunctionCall({ callId: 'call', name: 'lookup', args: '{}' }));
    if (kind === 'split-tool')
      ctx.addMessage({ role: 'assistant', content: 'Between call and result' });
    if (kind === 'orphan' || kind === 'split-tool')
      ctx.items.push(new llm.FunctionCallOutput({ callId: 'call', output: '42', isError: false }));
    const before = peer.requests.length;
    await expect(session.updateChatCtx(ctx)).rejects.toThrow();
    expect(peer.requests).toHaveLength(before);
    expect(session.chatCtx.items).toHaveLength(3);
  },
);

it('imports completed tools and deletes each pair once', async () => {
  const { peer, session } = await setup();
  const ctx = session.chatCtx;
  ctx.items.push(new llm.FunctionCall({ callId: 'old', name: 'lookup', args: '{}' }));
  ctx.items.push(new llm.FunctionCallOutput({ callId: 'old', output: 'Oops', isError: true }));
  await session.updateChatCtx(ctx);
  expect(peer.history.at(-1)?.output).toContain('tool_error');
  await session.updateChatCtx(llm.ChatContext.empty());
  expect(peer.requests.filter((q) => q.type === 'conversation.item.delete')).toHaveLength(4);
  expect(peer.history).toEqual([]);
});

it('fails the session when a batch partially applies', async () => {
  const { peer, session } = await setup();
  const errors: llm.RealtimeModelError[] = [];
  session.on('error', (error) => errors.push(error));
  let mutations = 0;
  peer.onRequest = (q) => {
    if (q.type === 'conversation.item.create' && ++mutations === 2) {
      peer.fault(q, 'invalid_item');
      return true;
    }
  };
  const ctx = session.chatCtx;
  ctx.addMessage({ role: 'user', content: 'First' });
  ctx.addMessage({ role: 'user', content: 'Second' });
  await expect(session.updateChatCtx(ctx)).rejects.toThrow('partially applied');
  await session.close();
  expect(errors.filter((error) => !error.recoverable)).toHaveLength(1);
  await expect(session.updateInstructions('Do not continue')).rejects.toThrow();
});

it('preserves events received while an edit waits for acknowledgment', async () => {
  const { peer, session } = await setup();
  peer.onRequest = (q) => {
    if (q.type !== 'conversation.item.create') return;
    peer.emit('input_audio_buffer.committed', { item_id: 'spoken' });
    peer.emit('conversation.item.input_audio_transcription.completed', {
      item_id: 'spoken',
      transcript: 'Spoken during update',
    });
  };
  const ctx = session.chatCtx;
  ctx.addMessage({ role: 'user', content: 'Typed' });
  await session.updateChatCtx(ctx);
  await vi.waitFor(() => expect(session.chatCtx.getById('spoken')).toBeDefined());
  expect(session.chatCtx.items).toHaveLength(5);
});

it('does not replace live records with an incomplete server snapshot', async () => {
  const { peer, session } = await setup();
  peer.accepted(undefined, 'live');
  peer.tool('live');
  await vi.waitFor(() => expect(session.chatCtx.getById('item-call-1')).toBeDefined());
  peer.history = [];
  expect(await session.getHistory()).toEqual([]);
  expect(session.chatCtx.getById('item-call-1')).toBeDefined();
  const ctx = session.chatCtx;
  ctx.items.reverse();
  await expect(session.updateChatCtx(ctx)).rejects.toThrow();
  peer.ended('live');
});
