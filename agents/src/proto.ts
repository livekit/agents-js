// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Timestamp } from '@bufbuild/protobuf';
import { AgentSession as pb } from '@livekit/protocol';
import type { ChatItem } from './llm/chat_context.js';
import { isInstructions } from './llm/chat_context.js';

/**
 * Mapping between the SDK's own types and the agent_session wire format.
 *
 * A leaf: nothing here imports voice or telemetry, so every path that puts a ChatItem
 * on the wire can share one implementation.
 */

export type RemoteChatItem = Exclude<ChatItem, { type: 'agent_config_update' }>;

export function msToTimestamp(ms: number): Timestamp {
  return Timestamp.fromDate(new Date(ms));
}

export function chatItemToProto(item: RemoteChatItem): pb.ChatContext_ChatItem {
  switch (item.type) {
    case 'message': {
      const msg = item;
      const roleMap: Record<string, pb.ChatRole> = {
        developer: pb.ChatRole.DEVELOPER,
        system: pb.ChatRole.SYSTEM,
        user: pb.ChatRole.USER,
        assistant: pb.ChatRole.ASSISTANT,
      };
      const content: pb.ChatMessage_ChatContent[] = [];
      for (const c of msg.content) {
        if (typeof c === 'string') {
          content.push(new pb.ChatMessage_ChatContent({ payload: { case: 'text', value: c } }));
        } else if (isInstructions(c)) {
          content.push(
            new pb.ChatMessage_ChatContent({ payload: { case: 'text', value: c.value } }),
          );
        }
      }

      const metricsReport = new pb.MetricsReport();
      if (msg.metrics.transcriptionDelay !== undefined)
        metricsReport.transcriptionDelay = msg.metrics.transcriptionDelay;
      if (msg.metrics.endOfTurnDelay !== undefined)
        metricsReport.endOfTurnDelay = msg.metrics.endOfTurnDelay;
      if (msg.metrics.onUserTurnCompletedDelay !== undefined)
        metricsReport.onUserTurnCompletedDelay = msg.metrics.onUserTurnCompletedDelay;
      if (msg.metrics.llmNodeTtft !== undefined)
        metricsReport.llmNodeTtft = msg.metrics.llmNodeTtft;
      if (msg.metrics.ttsNodeTtfb !== undefined)
        metricsReport.ttsNodeTtfb = msg.metrics.ttsNodeTtfb;
      if (msg.metrics.e2eLatency !== undefined) metricsReport.e2eLatency = msg.metrics.e2eLatency;

      const pbMsg = new pb.ChatMessage({
        id: msg.id,
        role: roleMap[msg.role] ?? pb.ChatRole.ASSISTANT,
        content,
        interrupted: msg.interrupted,
        metrics: metricsReport,
        createdAt: msToTimestamp(msg.createdAt),
      });
      if (msg.transcriptConfidence !== undefined) {
        pbMsg.transcriptConfidence = msg.transcriptConfidence;
      }
      return new pb.ChatContext_ChatItem({ item: { case: 'message', value: pbMsg } });
    }
    case 'function_call': {
      const fc = item;
      return new pb.ChatContext_ChatItem({
        item: {
          case: 'functionCall',
          value: new pb.FunctionCall({
            id: fc.id,
            callId: fc.callId,
            name: fc.name,
            arguments: fc.args,
            createdAt: msToTimestamp(fc.createdAt),
          }),
        },
      });
    }
    case 'function_call_output': {
      const fco = item;
      return new pb.ChatContext_ChatItem({
        item: {
          case: 'functionCallOutput',
          value: new pb.FunctionCallOutput({
            id: fco.id,
            callId: fco.callId,
            name: fco.name,
            output: fco.output,
            isError: fco.isError,
            createdAt: msToTimestamp(fco.createdAt),
          }),
        },
      });
    }
    case 'agent_handoff': {
      const ah = item;
      return new pb.ChatContext_ChatItem({
        item: {
          case: 'agentHandoff',
          value: new pb.AgentHandoff({
            id: ah.id,
            oldAgentId: ah.oldAgentId,
            newAgentId: ah.newAgentId,
            createdAt: msToTimestamp(ah.createdAt),
          }),
        },
      });
    }
  }
}
