// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Timestamp } from '@bufbuild/protobuf';
import { AgentSession as pb } from '@livekit/protocol';
import type { ChatItem, MetricsReport } from './llm/chat_context.js';
import { isInstructions, renderInstructions } from './llm/chat_context.js';

/**
 * Mapping between the SDK's own types and the agent_session wire format.
 *
 * A leaf: nothing here imports voice or telemetry, so every path that puts a ChatItem
 * on the wire can share one implementation.
 */

const ROLE_MAP: Record<string, pb.ChatRole> = {
  developer: pb.ChatRole.DEVELOPER,
  system: pb.ChatRole.SYSTEM,
  user: pb.ChatRole.USER,
  assistant: pb.ChatRole.ASSISTANT,
};

export function msToTimestamp(ms: number): Timestamp {
  return Timestamp.fromDate(new Date(ms));
}

export function msToUnixSeconds(ms: number): number {
  const timestamp = msToTimestamp(ms);
  return Number(timestamp.seconds) + timestamp.nanos / 1e9;
}

function encodeMetrics(metrics: MetricsReport): pb.MetricsReport {
  const report = new pb.MetricsReport();
  // wall-clock metrics are seconds here and Timestamps on the wire
  if (metrics.startedSpeakingAt !== undefined)
    report.startedSpeakingAt = msToTimestamp(metrics.startedSpeakingAt * 1000);
  if (metrics.stoppedSpeakingAt !== undefined)
    report.stoppedSpeakingAt = msToTimestamp(metrics.stoppedSpeakingAt * 1000);
  if (metrics.transcriptionDelay !== undefined)
    report.transcriptionDelay = metrics.transcriptionDelay;
  if (metrics.endOfTurnDelay !== undefined) report.endOfTurnDelay = metrics.endOfTurnDelay;
  if (metrics.onUserTurnCompletedDelay !== undefined)
    report.onUserTurnCompletedDelay = metrics.onUserTurnCompletedDelay;
  if (metrics.llmNodeTtft !== undefined) report.llmNodeTtft = metrics.llmNodeTtft;
  if (metrics.ttsNodeTtfb !== undefined) report.ttsNodeTtfb = metrics.ttsNodeTtfb;
  if (metrics.e2eLatency !== undefined) report.e2eLatency = metrics.e2eLatency;
  return report;
}

export function encodeChatItem(item: ChatItem): pb.ChatContext_ChatItem {
  switch (item.type) {
    case 'message': {
      const content: pb.ChatMessage_ChatContent[] = [];
      for (const c of item.content) {
        if (typeof c === 'string') {
          content.push(new pb.ChatMessage_ChatContent({ payload: { case: 'text', value: c } }));
        } else if (isInstructions(c)) {
          content.push(
            new pb.ChatMessage_ChatContent({ payload: { case: 'text', value: c.value } }),
          );
        }
      }

      const pbMsg = new pb.ChatMessage({
        id: item.id,
        role: ROLE_MAP[item.role] ?? pb.ChatRole.ASSISTANT,
        content,
        interrupted: item.interrupted,
        metrics: encodeMetrics(item.metrics),
        // the proto map is <string, string>; livekit/agents coerces the same way
        extra: Object.fromEntries(Object.entries(item.extra).map(([k, v]) => [k, String(v)])),
        createdAt: msToTimestamp(item.createdAt),
      });
      if (item.transcriptConfidence !== undefined) {
        pbMsg.transcriptConfidence = item.transcriptConfidence;
      }
      return new pb.ChatContext_ChatItem({ item: { case: 'message', value: pbMsg } });
    }
    case 'function_call':
      return new pb.ChatContext_ChatItem({
        item: {
          case: 'functionCall',
          value: new pb.FunctionCall({
            id: item.id,
            callId: item.callId,
            name: item.name,
            arguments: item.args,
            createdAt: msToTimestamp(item.createdAt),
          }),
        },
      });
    case 'function_call_output':
      return new pb.ChatContext_ChatItem({
        item: {
          case: 'functionCallOutput',
          value: new pb.FunctionCallOutput({
            id: item.id,
            callId: item.callId,
            name: item.name,
            output: item.output,
            isError: item.isError,
            createdAt: msToTimestamp(item.createdAt),
          }),
        },
      });
    case 'agent_handoff':
      return new pb.ChatContext_ChatItem({
        item: {
          case: 'agentHandoff',
          value: new pb.AgentHandoff({
            id: item.id,
            oldAgentId: item.oldAgentId,
            newAgentId: item.newAgentId,
            createdAt: msToTimestamp(item.createdAt),
          }),
        },
      });
    case 'agent_config_update':
      return new pb.ChatContext_ChatItem({
        item: {
          case: 'agentConfigUpdate',
          value: new pb.AgentConfigUpdate({
            id: item.id,
            instructions:
              item.instructions !== undefined ? renderInstructions(item.instructions) : undefined,
            toolsAdded: item.toolsAdded,
            toolsRemoved: item.toolsRemoved,
            createdAt: msToTimestamp(item.createdAt),
          }),
        },
      });
  }
}
