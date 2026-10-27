// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { initializeLogger, llm } from '@livekit/agents';
import type * as r from '@rimelabs/sdk';
import { afterEach, expect, it, vi } from 'vitest';
import {
  type PrismItemTruncatedEvent,
  type PrismResponseEndedEvent,
  RealtimeModel,
} from './realtime_model.js';
import { PrismPeer, type Request } from './test_helpers.js';

initializeLogger({ pretty: false, level: 'silent' });
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function setup() {
  const peer = await new PrismPeer().start();
  cleanup.push(() => peer.close());
  const model = new RealtimeModel({
    endpoint: peer.endpoint,
    apiKey: 'test',
    requestTimeout: 1000,
  });
  cleanup.push(() => model.close());
  const session = model.session();
  session.on('error', () => {});
  await session.updateInstructions('Test');
  const cuts: PrismItemTruncatedEvent[] = [];
  const ends: PrismResponseEndedEvent[] = [];
  session.on('item_truncated', (event) => cuts.push(event));
  session.on('response_ended', (event) => ends.push(event));
  return { peer, session, cuts, ends };
}
function acknowledge(
  peer: PrismPeer,
  keptText: string | null,
  itemId = 'message-reply-1',
  contentIndex = 0,
) {
  peer.emit('conversation.item.truncated', {
    item_id: itemId,
    content_index: contentIndex,
    audio_end_ms: 120,
    ...(keptText === null ? {} : { prism_kept_text: keptText }),
  });
}
async function completed({ peer, session }: Awaited<ReturnType<typeof setup>>) {
  peer.accepted();
  peer.message();
  peer.text('The full generated answer');
  peer.ended();
  await vi.waitFor(() => expect(session.chatCtx.getById('message-reply-1')).toBeDefined());
}

it.each([null, '', 'The full', 'The full generated answer'])(
  'applies retained text %j without changing snapshots or metadata',
  async (keptText) => {
    const state = await setup();
    const { peer, session, cuts } = state;
    await completed(state);
    const before = session.chatCtx.getById('message-reply-1') as llm.ChatMessage;
    acknowledge(peer, keptText);
    await vi.waitFor(() => expect(cuts).toHaveLength(1));
    const after = session.chatCtx.getById(before.id) as llm.ChatMessage;
    expect(after.content).toEqual([keptText ?? before.textContent]);
    expect(after.createdAt).toBe(before.createdAt);
    expect(before.textContent).toBe('The full generated answer');
    expect(cuts[0]).toMatchObject({
      itemId: before.id,
      contentIndex: 0,
      audioEndMs: 120,
      keptText,
    });
    acknowledge(peer, null);
    await vi.waitFor(() => expect(cuts).toHaveLength(2));
    expect(session.chatCtx.getById(before.id)).toEqual(after);
  },
);

it.each([null, '', 'Retained words'])(
  'preserves early retained text %j through completion and cleanup',
  async (keptText) => {
    const { peer, session, cuts, ends } = await setup();
    peer.accepted();
    peer.message();
    peer.text('Generated words');
    acknowledge(peer, keptText);
    acknowledge(peer, null);
    await vi.waitFor(() => expect(cuts).toHaveLength(2));
    peer.ended();
    await vi.waitFor(() => expect(ends).toHaveLength(1));
    expect((session.chatCtx.getById('message-reply-1') as llm.ChatMessage).content).toEqual([
      keptText ?? 'Generated words',
    ]);
    await session.updateChatCtx(llm.ChatContext.empty());
    await session.close();
    expect(session.chatCtx.items).toEqual([]);
  },
);

it.each(['', 'Server retained all words'])(
  'keeps early retained text %j when cancellation records a playback transcript',
  async (keptText) => {
    const { peer, session, cuts } = await setup();
    peer.accepted();
    peer.message();
    peer.text('Generated words');
    acknowledge(peer, keptText);
    await vi.waitFor(() => expect(cuts).toHaveLength(1));
    await session.truncate({
      messageId: 'message-reply-1',
      audioEndMs: 120,
      audioTranscript: 'Played',
    });
    expect((session.chatCtx.getById('message-reply-1') as llm.ChatMessage).content).toEqual([
      keptText,
    ]);
  },
);

it.each(['delete', 'replace'])('ignores stale acknowledgments after history %s', async (edit) => {
  const state = await setup();
  const { peer, session, cuts } = state;
  await completed(state);
  const target = session.chatCtx;
  if (edit === 'delete') target.items = [];
  else (target.getById('message-reply-1') as llm.ChatMessage).content = ['Replacement'];
  await session.updateChatCtx(target);
  acknowledge(peer, 'Stale text');
  await vi.waitFor(() => expect(cuts).toHaveLength(1));
  expect(session.chatCtx.items).toEqual(target.items);
  if (edit === 'replace') {
    const serverId = peer.history.find((item) => item.role === 'assistant')!.id!;
    acknowledge(peer, 'New retained text', serverId);
    await vi.waitFor(() => expect(cuts).toHaveLength(2));
    expect((session.chatCtx.getById('message-reply-1') as llm.ChatMessage).content).toEqual([
      'New retained text',
    ]);
  }
});

it.each(['append', 'delete', 'replace'])(
  'preserves acknowledged history during a pending %s edit',
  async (edit) => {
    const state = await setup();
    const { peer, session, cuts } = state;
    await completed(state);
    const target = session.chatCtx;
    if (edit === 'append') target.addMessage({ role: 'user', content: 'Next' });
    else if (edit === 'delete') target.items = [];
    else (target.getById('message-reply-1') as llm.ChatMessage).content = ['Replacement'];
    let held: Request | undefined;
    peer.onRequest = (request) => {
      if (
        request.type === 'conversation.item.create' ||
        request.type === 'conversation.item.delete'
      ) {
        held = request;
        return true;
      }
    };
    const update = session.updateChatCtx(target);
    try {
      await vi.waitFor(() => expect(held).toBeDefined());
      acknowledge(peer, 'Retained words');
      await vi.waitFor(() => expect(cuts).toHaveLength(1));
    } finally {
      peer.onRequest = undefined;
      if (held?.type === 'conversation.item.create') {
        const item = { ...held.item!, id: 'held-item' };
        peer.history.push(item);
        peer.emit('conversation.item.created', { prism_request_event_id: held.event_id, item });
      } else if (held)
        peer.emit('conversation.item.deleted', {
          prism_request_event_id: held.event_id,
          item_id: held.item_id,
        });
      await update;
    }
    if (edit === 'append') {
      expect((session.chatCtx.getById('message-reply-1') as llm.ChatMessage).content).toEqual([
        'Retained words',
      ]);
      expect(session.chatCtx.items.at(-1)).toEqual(target.items.at(-1));
    } else expect(session.chatCtx.items).toEqual(target.items);
  },
);

it('treats unknown items and other content parts as diagnostics only', async () => {
  const state = await setup();
  const { peer, session, cuts } = state;
  await completed(state);
  const before = session.chatCtx;
  acknowledge(peer, 'Unknown', 'unknown');
  acknowledge(peer, 'Other part', 'message-reply-1', 1);
  await vi.waitFor(() => expect(cuts).toHaveLength(2));
  expect(session.chatCtx.items).toEqual(before.items);
});

it.each(['completed', 'cancelled', 'failed'])(
  'exposes %s response summaries without deleting history',
  async (status) => {
    const state = await setup();
    const { peer, session, cuts, ends } = state;
    await completed(state);
    const before = session.chatCtx;
    for (const [index, summary] of [
      undefined,
      { items_left_out: 3 },
      { items_left_out: 3, first_kept_item_id: 'kept' },
    ].entries()) {
      const id = `summary-${index}`;
      peer.accepted(undefined, id);
      peer.emit('response.done', {
        response: { id, status, ...(summary === undefined ? {} : { prism_truncation: summary }) },
      });
      await vi.waitFor(() => expect(ends).toHaveLength(index + 2));
      expect(ends.at(-1)).toMatchObject({
        status,
        truncation: summary
          ? { itemsLeftOut: 3, firstKeptItemId: summary.first_kept_item_id ?? null }
          : null,
      });
      expect(session.chatCtx.items).toEqual(before.items);
    }
    // History acknowledgments do not depend on completed response records.
    (session as unknown as { generations: Map<string, unknown> }).generations.clear();
    acknowledge(peer, 'Retained');
    await vi.waitFor(() => expect(cuts).toHaveLength(1));
    expect((session.chatCtx.getById('message-reply-1') as llm.ChatMessage).content).toEqual([
      'Retained',
    ]);
  },
);

it.each(
  [false, true].flatMap((abandoned) =>
    [false, true].flatMap((afterEnd) =>
      ['', 'Retained'].map((keptText) => ({ abandoned, afterEnd, keptText })),
    ),
  ),
)(
  'preserves buffered truncation with abandoned=$abandoned afterEnd=$afterEnd keptText=$keptText',
  async ({ abandoned, afterEnd, keptText }) => {
    const { peer, session, cuts, ends } = await setup();
    const sdk = (session as unknown as { sdk: r.RealtimeSession }).sdk;
    const original = sdk.requestReply.bind(sdk);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(sdk, 'requestReply').mockImplementation(async (...args) => {
      const ref = await original(...args);
      await gate;
      return ref;
    });
    const controller = new AbortController();
    const reply = session.generateReply(undefined, { signal: controller.signal });
    const result = reply.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    try {
      await vi.waitFor(() =>
        expect(peer.requests.some((q) => q.type === 'response.create')).toBe(true),
      );
      peer.accepted(peer.requests.find((q) => q.type === 'response.create'));
      peer.message();
      peer.text('Generated');
      if (afterEnd) peer.ended();
      acknowledge(peer, keptText);
      acknowledge(peer, null);
      if (!afterEnd) peer.ended();
      await vi.waitFor(() => {
        expect(cuts).toHaveLength(2);
        expect(ends).toHaveLength(1);
      });
      expect(session.chatCtx.items).toEqual([]);
      if (abandoned) controller.abort();
    } finally {
      release();
    }
    const outcome = await result;
    if (abandoned) {
      expect(outcome).toHaveProperty('error');
      expect(session.chatCtx.items).toEqual([]);
    } else {
      expect(outcome).toHaveProperty('value');
      expect((session.chatCtx.getById('message-reply-1') as llm.ChatMessage).content).toEqual([
        keptText,
      ]);
    }
    expect(cuts).toHaveLength(2);
  },
);
