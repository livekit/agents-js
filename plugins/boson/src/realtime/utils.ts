// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { llm, shortuuid } from '@livekit/agents';
import type { realtime } from '@livekit/agents-plugin-openai';

export type BosonSessionValue = Record<string, unknown> | null | undefined;

export function normalizeWsUrl(url: string, queryParams: Record<string, string> = {}): string {
  const parsed = new URL(url);
  if (parsed.protocol === 'http:') parsed.protocol = 'ws:';
  if (parsed.protocol === 'https:') parsed.protocol = 'wss:';
  for (const [key, value] of Object.entries(queryParams)) parsed.searchParams.set(key, value);
  return parsed.toString().replace(/\/$/, parsed.pathname === '/' ? '/' : '');
}

export function mergeSessionValue(base: unknown, update: unknown): unknown {
  if (!isRecord(base) || !isRecord(update)) return update;
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(update)) {
    merged[key] = mergeSessionValue(merged[key], value);
  }
  return merged;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeTranscription(
  value: Record<string, unknown> | null | undefined,
): Record<string, unknown> | undefined {
  if (value == null) return undefined;
  const transcription = { ...value };
  delete transcription.prompt;
  return transcription;
}

export function transcriptionEnabled(value: unknown): boolean {
  return isRecord(value) && typeof value.model === 'string' && value.model.length > 0;
}

export function sessionUpdate(
  prefix: string,
  session: Record<string, unknown>,
): realtime.SessionUpdateEvent {
  return {
    type: 'session.update',
    event_id: shortuuid(prefix),
    session: { type: 'realtime', ...session },
  } as realtime.SessionUpdateEvent;
}

export function toolChoiceToBoson(
  choice?: llm.ToolChoice | null,
): realtime.ToolChoice | { type: 'function'; name: string } {
  if (typeof choice === 'string') return choice;
  return choice?.type === 'function' ? { type: 'function', name: choice.function.name } : 'auto';
}

export function toolsToBoson(tools: llm.Tool[]): realtime.Tool[] {
  return tools.filter(llm.isFunctionTool).map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: llm.toJsonSchema(tool.parameters) as realtime.Tool['parameters'],
  }));
}

export function textFromContent(content: llm.ChatContent[]): string {
  return content
    .flatMap((part) => {
      if (typeof part === 'string') return [part];
      if (part.type === 'audio_content' && part.transcript) return [part.transcript];
      return [];
    })
    .join('\n');
}

export function setMessageText(message: llm.ChatMessage, text: string): void {
  const index = message.content.findIndex((part) => typeof part === 'string');
  if (index === -1) message.content.push(text);
  else message.content[index] = text;
}

export function livekitItemToBosonItem(
  item: llm.ChatItem,
): realtime.ConversationItemCreateContent | undefined {
  if (item.type === 'message') {
    if (item.role === 'system' || item.role === 'developer') return undefined;
    const text = textFromContent(item.content);
    if (!text) return undefined;
    return {
      id: item.id,
      object: 'realtime.item',
      type: 'message',
      role: item.role,
      content: [{ type: item.role === 'assistant' ? 'text' : 'input_text', text }],
    } as realtime.ConversationItemCreateContent;
  }
  if (item.type === 'function_call') {
    return {
      id: item.id,
      object: 'realtime.item',
      type: 'function_call',
      call_id: item.callId,
      name: item.name,
      arguments: item.args,
      status: 'completed',
    } as unknown as realtime.ConversationItemCreateContent;
  }
  if (item.type === 'function_call_output') {
    return {
      id: item.id,
      object: 'realtime.item',
      type: 'function_call_output',
      call_id: item.callId,
      output: item.output,
      status: 'completed',
    } as unknown as realtime.ConversationItemCreateContent;
  }
  return undefined;
}

export function formatError(error: Record<string, unknown>, eventId?: string): string {
  const message = typeof error.message === 'string' ? error.message : 'Boson realtime API error';
  const details = [
    typeof error.type === 'string' ? `type=${error.type}` : undefined,
    typeof error.code === 'string' ? `code=${error.code}` : undefined,
    eventId ? `event_id=${eventId}` : undefined,
  ].filter(Boolean);
  return details.length ? `${message} (${details.join(', ')})` : message;
}
