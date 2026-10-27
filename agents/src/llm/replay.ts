// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Serves LLM requests from a recorded session instead of the provider.
 *
 * With `LIVEKIT_LLM_REPLAY_URL` set (`lk agent simulate replay` sets it), every provider
 * request is posted there as the GenAI attributes its `llm_request` span records, and the
 * response is the output that request got in the recorded session. The server owns the
 * comparison: a request that differs from the recorded one, or arrives out of order, is
 * refused, and the stream raises instead of falling back to the provider.
 */
import { APIStatusError } from '../_exceptions.js';
import { genAI, traceTypes } from '../telemetry/index.js';
import { type ChatContext, FunctionCall } from './chat_context.js';
import type { ChatChunk } from './llm.js';
import type { ToolContext } from './tool_context.js';

export const ENV_LLM_REPLAY_URL = 'LIVEKIT_LLM_REPLAY_URL';

export function replayUrl(): string | undefined {
  return process.env[ENV_LLM_REPLAY_URL] || undefined;
}

interface ReplayPart {
  type?: string;
  content?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
}

interface ReplayResponse {
  error?: string;
  response_id?: string;
  output_messages?: Array<{ parts?: ReplayPart[] }>;
}

/** Posts the request and returns the chunks of the recorded output, one per message. */
export async function replay(
  url: string,
  {
    model,
    provider,
    chatCtx,
    toolCtx,
  }: { model: string; provider: string; chatCtx: ChatContext; toolCtx?: ToolContext },
): Promise<ChatChunk[]> {
  // the same serialization the llm_request span records, so the server compares like with like
  const request = {
    model,
    provider: traceTypes.genAIProviderName(provider) ?? null,
    system_instructions: genAI.toSystemInstructions(chatCtx),
    input_messages: genAI.toInputMessages(chatCtx),
    tool_definitions: toolCtx ? genAI.toToolDefinitions(toolCtx.functionTools) : [],
  };
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  const body = (await resp.json()) as ReplayResponse;
  if (!resp.ok) {
    throw new APIStatusError({
      message: `replay: ${body.error ?? resp.statusText}`,
      options: { statusCode: resp.status, body, retryable: false },
    });
  }

  return (body.output_messages ?? []).map((message) => {
    let content = '';
    const toolCalls: FunctionCall[] = [];
    for (const part of message.parts ?? []) {
      if (part.type === 'text') {
        content += part.content ?? '';
      } else if (part.type === 'tool_call') {
        toolCalls.push(
          FunctionCall.create({
            callId: part.id!,
            name: part.name!,
            args:
              typeof part.arguments === 'string'
                ? part.arguments
                : JSON.stringify(part.arguments ?? ''),
          }),
        );
      }
    }
    return {
      id: body.response_id ?? '',
      delta: { role: 'assistant', content: content || undefined, toolCalls },
    };
  });
}
