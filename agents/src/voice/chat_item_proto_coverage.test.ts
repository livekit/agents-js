// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { Message } from '@bufbuild/protobuf';
import { AgentSession as pb } from '@livekit/protocol';
import { describe, expect, it } from 'vitest';
import {
  AgentConfigUpdate,
  AgentHandoffItem,
  type ChatItem,
  ChatMessage,
  FunctionCall,
  FunctionCallOutput,
} from '../llm/chat_context.js';
import { encodeChatItem } from '../proto.js';

const TS = 1_700_000_000_500;

// Fields the wire format declares but this SDK cannot supply yet. An entry here is a
// deliberate parity gap; anything else missing is an accidental drop.
const KNOWN_GAPS = new Set([
  // llm tps/ttfs land in livekit/agents (#6373) but were never ported to this SDK,
  // so MetricsReport has no field to read them from.
  'metrics.llm_node_tps',
  'metrics.llm_node_ttfs',
]);

// Every field carries a non-default value: a proto3 scalar left at its zero value is
// indistinguishable from one the serializer never assigned.
const SATURATED_ITEMS: ChatItem[] = [
  new ChatMessage({
    id: 'item_msg',
    role: 'user',
    content: ['hello'],
    interrupted: true,
    transcriptConfidence: 0.75,
    extra: { key: 'value' },
    createdAt: TS,
    metrics: {
      startedSpeakingAt: TS / 1000,
      stoppedSpeakingAt: TS / 1000,
      transcriptionDelay: 1,
      endOfTurnDelay: 1,
      onUserTurnCompletedDelay: 1,
      llmNodeTtft: 1,
      ttsNodeTtfb: 1,
      e2eLatency: 1,
    },
  }),
  new FunctionCall({ id: 'item_fc', callId: 'call-1', name: 'fn', args: '{}', createdAt: TS }),
  new FunctionCallOutput({
    id: 'item_fco',
    callId: 'call-1',
    name: 'fn',
    output: 'ok',
    isError: true,
    createdAt: TS,
  }),
  new AgentHandoffItem({
    id: 'item_ah',
    oldAgentId: 'a',
    newAgentId: 'b',
    createdAt: TS,
  }),
  new AgentConfigUpdate({
    id: 'item_acu',
    instructions: 'be brief',
    toolsAdded: ['x'],
    toolsRemoved: ['y'],
    createdAt: TS,
  }),
];

function unsetFields(msg: Message, prefix = ''): string[] {
  const json = msg.toJson() as Record<string, unknown>;
  const missing: string[] = [];
  for (const f of msg.getType().fields.list()) {
    const key = f.jsonName ?? f.localName;
    if (!(key in json)) {
      missing.push(prefix + f.name);
      continue;
    }
    // well-known types are leaves; their own fields are legitimately zero
    if (f.kind === 'message' && !f.repeated && !f.T.typeName.startsWith('google.protobuf.')) {
      const nested = (msg as unknown as Record<string, Message>)[f.localName];
      missing.push(...unsetFields(nested, `${prefix}${f.name}.`));
    }
  }
  return missing;
}

function payloadOf(item: ChatItem): { which: string; message: Message } {
  const pbItem = encodeChatItem(item);
  const { case: which, value } = pbItem.item;
  if (!which) throw new Error('serializer produced an empty oneof');
  return { which, message: value as Message };
}

describe('ChatItem proto coverage', () => {
  it.each(SATURATED_ITEMS.map((item) => [item.type, item] as const))(
    '%s reaches every proto field',
    (_type, item) => {
      const { which, message } = payloadOf(item);
      const dropped = unsetFields(message).filter((f) => !KNOWN_GAPS.has(f));
      expect(dropped, `${which} drops: ${dropped.join(', ')}`).toEqual([]);
    },
  );

  it('detects a dropped field', () => {
    const fco = new pb.FunctionCallOutput({
      callId: 'call-1',
      name: 'fn',
      output: 'ok',
      isError: true,
    });
    expect(unsetFields(fco)).toEqual(['id', 'created_at']);
  });

  it('every known gap names a real proto field', () => {
    const declared = new Set(pb.MetricsReport.fields.list().map((f) => `metrics.${f.name}`));
    for (const gap of KNOWN_GAPS) {
      expect(declared, `${gap} is allowlisted but not in the proto`).toContain(gap);
    }
  });

  it('covers every case the oneof declares', () => {
    const declared = pb.ChatContext_ChatItem.fields.list().map((f) => f.localName);
    const covered = SATURATED_ITEMS.map((item) => payloadOf(item).which);
    expect(new Set(covered)).toEqual(new Set(declared));
  });
});
