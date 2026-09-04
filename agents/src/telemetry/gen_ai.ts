// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Builders for the OpenTelemetry GenAI semantic conventions.
 *
 * Translates LiveKit's own types — {@link ChatContext}, {@link FunctionCall}, tool
 * definitions, token usage — into the shapes the GenAI semantic conventions define, so a span
 * LiveKit produces is understood by any backend that speaks the convention (Datadog Agent
 * Observability, Langfuse, Braintrust, an OTLP collector) without a LiveKit-specific mapping.
 *
 * Message content follows the `gen_ai.input.messages` / `gen_ai.output.messages` /
 * `gen_ai.system_instructions` JSON schemas from
 * https://github.com/open-telemetry/semantic-conventions-genai. OpenTelemetry attributes
 * cannot hold structured values, so the convention's fallback applies and each value is
 * recorded as a JSON string.
 *
 * Content capture is on by default, matching the `lk.pii.*` content LiveKit already records,
 * and can be turned off process-wide with {@link setCaptureContent} or the
 * `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` environment variable. It is stripped
 * before any exporter that is not LiveKit Cloud's regardless — see `telemetry/pii.ts`.
 */
import type { Attributes, Span } from '@opentelemetry/api';
import { context as otelContext } from '@opentelemetry/api';
import { getJobContext } from '../job.js';
import type { ChatContext, ChatItem } from '../llm/chat_context.js';
import type { RealtimeModelMetrics } from '../metrics/base.js';
import * as traceTypes from './trace_types.js';

// Only type-only imports from `llm` here: a runtime import would pull the whole llm graph
// in behind the telemetry barrel, which llm itself imports. Chat items and tools are
// matched on their own `type` discriminants instead.

const FALSY = new Set(['0', 'false', 'no', 'off']);

// the env var name the GenAI conventions standardise for this opt-in
let captureContent = !FALSY.has(
  (process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT ?? '').trim().toLowerCase(),
);

/**
 * Turn recording of GenAI message content on or off for the process.
 *
 * When off, spans still carry every non-content GenAI attribute (model, provider, token
 * usage, finish reasons, tool names), but `gen_ai.input.messages`, `gen_ai.output.messages`,
 * `gen_ai.system_instructions`, `gen_ai.tool.definitions` and
 * `gen_ai.tool.call.{arguments,result}` are omitted.
 */
export function setCaptureContent(enabled: boolean): void {
  captureContent = enabled;
}

// ---------------------------------------------------------------------------
// message models
// ---------------------------------------------------------------------------

export interface MessagePart {
  type: string;
  [key: string]: unknown;
}

export interface ChatMessagePayload {
  role: string;
  parts: MessagePart[];
  finishReason?: string;
  [key: string]: unknown;
}

// A custom `llmNode` may do the inference itself — returning a plain string, streaming its
// own chunks, or calling a third-party engine — and never construct an LLMStream. Those paths
// have no nested `llm_request` span to carry the convention's attributes, so the node span
// records them instead. LLMStream marks the context when it does create one, which is what
// tells the two cases apart.
const INFERENCE_RECORDED = Symbol('lkInferenceRecorded');

export interface InferenceMarker {
  recorded: boolean;
}

/** Runs `fn` with a marker that fills in if an `llm_request` span is created inside it. */
export function withInferenceTracking<T>(fn: (marker: InferenceMarker) => T): T {
  const marker: InferenceMarker = { recorded: false };
  return otelContext.with(otelContext.active().setValue(INFERENCE_RECORDED, marker), () =>
    fn(marker),
  );
}

/** Called where an `llm_request` span is created, so the enclosing node stands down. */
export function markInferenceSpanRecorded(): void {
  const marker = otelContext.active().getValue(INFERENCE_RECORDED) as InferenceMarker | undefined;
  if (marker) marker.recorded = true;
}

function textPart(content: string): MessagePart {
  return { type: 'text', content };
}

/** Best-effort deserialization, as the convention asks of instrumentations. */
function maybeJson(raw: string): unknown {
  if (!raw) return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function messageParts(item: ChatItem): MessagePart[] {
  const parts: MessagePart[] = [];
  if (item.type === 'message') {
    for (const content of item.content) {
      if (typeof content === 'string') {
        parts.push(textPart(content));
      } else if (content.type === 'instructions') {
        parts.push(textPart(content.value));
      } else if (content.type === 'image_content') {
        // a data: URL is inline bytes, which the convention models as a blob; recording the
        // base64 payload on a span is never worth its size, so both forms are reported as a
        // uri part without the payload
        const image = content.image;
        parts.push({
          type: 'uri',
          modality: 'image',
          mime_type: content.mimeType,
          uri: typeof image === 'string' && !image.startsWith('data:') ? image : '',
        });
      } else if (content.type === 'audio_content') {
        const part: MessagePart = { type: 'blob', modality: 'audio', content: '' };
        if (content.transcript) {
          // the transcript is the only audio content worth carrying; the frames are
          // recorded separately by session recording, never on a span
          part.transcript = content.transcript;
        }
        parts.push(part);
      }
    }
  } else if (item.type === 'function_call') {
    parts.push({
      type: 'tool_call',
      id: item.callId,
      name: item.name,
      arguments: maybeJson(item.args),
    });
  } else if (item.type === 'function_call_output') {
    parts.push({
      type: 'tool_call_response',
      id: item.callId,
      response: maybeJson(item.output),
    });
  }
  return parts;
}

/**
 * The chat items to report, tolerating a context that carries none.
 *
 * Tracing must never be the thing that breaks an inference call, and a custom `llm_node` or a
 * test double may hand us an object without an `items` list.
 */
function itemsOf(chatCtx: ChatContext | undefined): readonly ChatItem[] {
  const items = chatCtx?.items;
  return Array.isArray(items) ? items : [];
}

/**
 * `gen_ai.system_instructions` — the agent instructions, as text parts.
 *
 * LiveKit carries an agent's instructions as `system`/`developer` messages in the chat
 * context, but they originate from the agent definition rather than from the conversation,
 * so they are reported as instructions rather than history.
 */
export function toSystemInstructions(chatCtx: ChatContext): MessagePart[] {
  const parts: MessagePart[] = [];
  for (const item of itemsOf(chatCtx)) {
    if (item.type === 'message' && (item.role === 'system' || item.role === 'developer')) {
      const text = item.rawTextContent;
      if (text !== undefined) parts.push(textPart(text));
    }
  }
  return parts;
}

/**
 * `gen_ai.input.messages` — the conversation history, in the order it was sent.
 *
 * `system`/`developer` messages are reported in `gen_ai.system_instructions` instead, and
 * non-conversational items (agent handoffs, config updates) are skipped.
 */
export function toInputMessages(chatCtx: ChatContext): ChatMessagePayload[] {
  const messages: ChatMessagePayload[] = [];
  for (const item of itemsOf(chatCtx)) {
    let role: string;
    if (item.type === 'message') {
      if (item.role === 'system' || item.role === 'developer') continue;
      role = item.role;
    } else if (item.type === 'function_call') {
      role = 'assistant';
    } else if (item.type === 'function_call_output') {
      role = 'tool';
    } else {
      continue;
    }

    const parts = messageParts(item);
    if (!parts.length) continue;

    // consecutive tool calls from one assistant turn belong to a single message
    const last = messages[messages.length - 1];
    if (
      last &&
      last.role === 'assistant' &&
      role === 'assistant' &&
      item.type === 'function_call'
    ) {
      last.parts.push(...parts);
      continue;
    }

    messages.push({ role, parts });
  }
  return messages;
}

export interface ToolCallLike {
  callId: string;
  name: string;
  args: string;
}

/** `gen_ai.output.messages` — the single assistant turn the model generated. */
export function toOutputMessages(params: {
  text?: string;
  functionCalls?: readonly ToolCallLike[];
  finishReason?: string;
}): ChatMessagePayload[] {
  const parts: MessagePart[] = [];
  if (params.text) parts.push(textPart(params.text));
  for (const call of params.functionCalls ?? []) {
    parts.push({
      type: 'tool_call',
      id: call.callId,
      name: call.name,
      arguments: maybeJson(call.args),
    });
  }
  if (!parts.length) return [];

  const message: ChatMessagePayload = { role: 'assistant', parts };
  if (params.finishReason) message.finish_reason = params.finishReason;
  return [message];
}

/**
 * `parameters` is deliberately omitted: the convention marks it NOT RECOMMENDED by default
 * because a schema is large, and building one per request would be pure overhead for
 * telemetry. Tools are matched structurally for the layering reason above.
 */
export function toToolDefinitions(
  tools: readonly unknown[] | Record<string, unknown>,
): MessagePart[] {
  const entries = Array.isArray(tools) ? tools : Object.values(tools ?? {});
  const definitions: MessagePart[] = [];
  for (const entry of entries) {
    const tool = entry as { type?: string; name?: string; description?: string; id?: string };
    if (tool?.type === 'function' && tool.name) {
      const definition: MessagePart = { type: 'function', name: tool.name };
      if (tool.description) definition.description = tool.description;
      definitions.push(definition);
    } else if (tool?.type === 'provider' && tool.id) {
      definitions.push({ type: tool.id, name: tool.id });
    }
  }
  return definitions;
}

export function finishReasonFor(params: {
  functionCalls?: readonly unknown[];
  interrupted?: boolean;
}): string {
  // checked first: a generation that emitted a tool call and then failed ended abnormally,
  // and the convention has no `cancelled` value for that
  if (params.interrupted) return traceTypes.GenAIFinishReason.ERROR;
  if (params.functionCalls?.length) return traceTypes.GenAIFinishReason.TOOL_CALL;
  return traceTypes.GenAIFinishReason.STOP;
}

// ---------------------------------------------------------------------------
// span attributes
// ---------------------------------------------------------------------------

function toJson(value: unknown): string {
  return JSON.stringify(value);
}

/**
 * `gen_ai.conversation.id` — the room a session runs in.
 *
 * The convention forbids fabricating one (no UUIDs, trace ids or content hashes), so this is
 * the room id LiveKit already stamps, and `undefined` outside a job context.
 */
export function conversationId(): string | undefined {
  return getJobContext(false)?.job?.room?.sid || undefined;
}

/** The `create_agent` / `invoke_agent` span attributes. */
/**
 * Record the convention's content attributes, when content capture is enabled.
 *
 * Values are JSON strings: OpenTelemetry attributes cannot hold structured values, which the
 * convention explicitly allows for spans.
 */
export function setContentAttributes(
  span: Span,
  content: {
    systemInstructions?: MessagePart[];
    inputMessages?: ChatMessagePayload[];
    outputMessages?: ChatMessagePayload[];
    toolDefinitions?: MessagePart[];
  },
): void {
  if (!captureContent || !span.isRecording()) return;

  const attrs: Attributes = {};
  if (content.systemInstructions?.length) {
    attrs[traceTypes.ATTR_GEN_AI_SYSTEM_INSTRUCTIONS] = toJson(content.systemInstructions);
  }
  if (content.inputMessages?.length) {
    attrs[traceTypes.ATTR_GEN_AI_INPUT_MESSAGES] = toJson(content.inputMessages);
  }
  if (content.outputMessages?.length) {
    attrs[traceTypes.ATTR_GEN_AI_OUTPUT_MESSAGES] = toJson(content.outputMessages);
  }
  if (content.toolDefinitions?.length) {
    attrs[traceTypes.ATTR_GEN_AI_TOOL_DEFINITIONS] = toJson(content.toolDefinitions);
  }
  if (Object.keys(attrs).length) span.setAttributes(attrs);
}

/** The attributes the convention asks for at span creation time. */
export function setRequestAttributes(
  span: Span,
  params: {
    operation: string;
    provider?: string;
    model?: string;
    stream?: boolean;
    outputType?: string;
  },
): void {
  if (!span.isRecording()) return;

  const attrs: Attributes = { [traceTypes.ATTR_GEN_AI_OPERATION_NAME]: params.operation };
  const provider = traceTypes.genAIProviderName(params.provider);
  if (provider) attrs[traceTypes.ATTR_GEN_AI_PROVIDER_NAME] = provider;
  if (params.model) attrs[traceTypes.ATTR_GEN_AI_REQUEST_MODEL] = params.model;
  // "if and only if the request is streaming; if unset, assumed non-streaming"
  if (params.stream) attrs[traceTypes.ATTR_GEN_AI_REQUEST_STREAM] = true;
  const conv = conversationId();
  if (conv) attrs[traceTypes.ATTR_GEN_AI_CONVERSATION_ID] = conv;
  if (params.outputType) attrs[traceTypes.ATTR_GEN_AI_OUTPUT_TYPE] = params.outputType;
  span.setAttributes(attrs);
}

export function setResponseAttributes(
  span: Span,
  params: {
    responseId?: string;
    model?: string;
    finishReasons?: string[];
    /** Time to first chunk, in seconds. */
    timeToFirstChunk?: number;
  },
): void {
  if (!span.isRecording()) return;

  const attrs: Attributes = {};
  if (params.responseId) attrs[traceTypes.ATTR_GEN_AI_RESPONSE_ID] = params.responseId;
  if (params.model) attrs[traceTypes.ATTR_GEN_AI_RESPONSE_MODEL] = params.model;
  if (params.finishReasons?.length) {
    attrs[traceTypes.ATTR_GEN_AI_RESPONSE_FINISH_REASONS] = params.finishReasons;
  }
  if (params.timeToFirstChunk !== undefined && params.timeToFirstChunk >= 0) {
    attrs[traceTypes.ATTR_GEN_AI_RESPONSE_TIME_TO_FIRST_CHUNK] = params.timeToFirstChunk;
  }
  if (Object.keys(attrs).length) span.setAttributes(attrs);
}

/**
 * Token usage in the convention's names.
 *
 * Per the convention the detailed counts are subsets of the totals, so cached and reasoning
 * tokens are reported alongside — not added to — input and output tokens.
 */
export function setUsageAttributes(
  span: Span,
  usage: {
    promptTokens?: number;
    completionTokens?: number;
    promptCachedTokens?: number;
    cacheCreationTokens?: number;
    reasoningTokens?: number;
  },
): void {
  if (!span.isRecording()) return;

  const attrs: Attributes = {
    [traceTypes.ATTR_GEN_AI_USAGE_INPUT_TOKENS]: usage.promptTokens ?? 0,
    [traceTypes.ATTR_GEN_AI_USAGE_OUTPUT_TOKENS]: usage.completionTokens ?? 0,
  };
  if (usage.promptCachedTokens) {
    attrs[traceTypes.ATTR_GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS] = usage.promptCachedTokens;
    // the unofficial spelling is what Datadog's mapping table keys on, and the realtime path
    // emits it; without this, cached tokens were attributed for realtime sessions and
    // silently absent for pipeline ones
    attrs[traceTypes.ATTR_GEN_AI_USAGE_INPUT_CACHED_TOKENS] = usage.promptCachedTokens;
  }
  if (usage.cacheCreationTokens) {
    attrs[traceTypes.ATTR_GEN_AI_USAGE_CACHE_WRITE_INPUT_TOKENS] = usage.cacheCreationTokens;
  }
  if (usage.reasoningTokens) {
    attrs[traceTypes.ATTR_GEN_AI_USAGE_REASONING_OUTPUT_TOKENS] = usage.reasoningTokens;
    // unofficial spelling recognised by Langfuse, kept alongside the standard one
    attrs[traceTypes.ATTR_GEN_AI_USAGE_REASONING_TOKENS] = usage.reasoningTokens;
  }
  span.setAttributes(attrs);
}

/** Token usage for a realtime (speech-to-speech) turn, per modality. */
export function realtimeUsageAttributes(metrics: RealtimeModelMetrics): Attributes {
  const attrs: Attributes = {
    [traceTypes.ATTR_GEN_AI_USAGE_INPUT_TOKENS]: metrics.inputTokens,
    [traceTypes.ATTR_GEN_AI_USAGE_OUTPUT_TOKENS]: metrics.outputTokens,
    [traceTypes.ATTR_GEN_AI_USAGE_TEXT_INPUT_TOKENS]: metrics.inputTokenDetails.textTokens,
    [traceTypes.ATTR_GEN_AI_USAGE_AUDIO_INPUT_TOKENS]: metrics.inputTokenDetails.audioTokens,
    [traceTypes.ATTR_GEN_AI_USAGE_TEXT_OUTPUT_TOKENS]: metrics.outputTokenDetails.textTokens,
    [traceTypes.ATTR_GEN_AI_USAGE_AUDIO_OUTPUT_TOKENS]: metrics.outputTokenDetails.audioTokens,
    [traceTypes.ATTR_GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS]: metrics.inputTokenDetails.cachedTokens,
  };
  return attrs;
}

/** The `execute_tool` span's attributes, per the convention. */
export function setToolAttributes(
  span: Span,
  params: {
    name: string;
    callId?: string;
    toolType?: string;
    description?: string;
    /** Raw (typically JSON) arguments as produced by the model. */
    args?: string;
    agentName?: string;
  },
): void {
  if (!span.isRecording()) return;

  const attrs: Attributes = {
    [traceTypes.ATTR_GEN_AI_OPERATION_NAME]: traceTypes.GenAIOperationName.EXECUTE_TOOL,
    [traceTypes.ATTR_GEN_AI_TOOL_NAME]: params.name,
    [traceTypes.ATTR_GEN_AI_TOOL_TYPE]: params.toolType ?? 'function',
  };
  if (params.callId) attrs[traceTypes.ATTR_GEN_AI_TOOL_CALL_ID] = params.callId;
  if (params.agentName) attrs[traceTypes.ATTR_GEN_AI_AGENT_NAME] = params.agentName;
  const conv = conversationId();
  if (conv) attrs[traceTypes.ATTR_GEN_AI_CONVERSATION_ID] = conv;
  if (captureContent) {
    if (params.description) attrs[traceTypes.ATTR_GEN_AI_TOOL_DESCRIPTION] = params.description;
    if (params.args !== undefined) {
      attrs[traceTypes.ATTR_GEN_AI_TOOL_CALL_ARGUMENTS] = toJson(maybeJson(params.args));
    }
  }
  span.setAttributes(attrs);
}

export function setToolResult(span: Span, params: { result?: string; isError: boolean }): void {
  if (!span.isRecording()) return;
  if (params.isError) {
    // the convention records the result only on success
    span.setAttribute(traceTypes.ATTR_ERROR_TYPE, 'tool_error');
    return;
  }
  if (captureContent && params.result !== undefined) {
    span.setAttribute(traceTypes.ATTR_GEN_AI_TOOL_CALL_RESULT, toJson(maybeJson(params.result)));
  }
}

/**
 * `error.type` — a low-cardinality identifier, per the convention.
 *
 * Never the error message: that is free-form and may carry user data.
 */
export function setErrorType(span: Span, error: Error | string): void {
  if (!span.isRecording()) return;
  if (typeof error === 'string') {
    span.setAttribute(traceTypes.ATTR_ERROR_TYPE, error);
    return;
  }
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  if (typeof statusCode === 'number') {
    span.setAttribute(traceTypes.ATTR_ERROR_TYPE, String(statusCode));
    return;
  }
  span.setAttribute(traceTypes.ATTR_ERROR_TYPE, error.constructor.name);
}

export function setAgentAttributes(
  span: Span,
  params: { operation: string; agentName: string; model?: string; provider?: string },
): void {
  if (!span.isRecording()) return;

  const attrs: Attributes = {
    [traceTypes.ATTR_GEN_AI_OPERATION_NAME]: params.operation,
    [traceTypes.ATTR_GEN_AI_AGENT_NAME]: params.agentName,
  };
  // required on create_agent; the model is conditionally required and an agent is
  // configured with exactly one, which is when the convention asks for it
  const normalizedProvider = traceTypes.genAIProviderName(params.provider);
  if (normalizedProvider) attrs[traceTypes.ATTR_GEN_AI_PROVIDER_NAME] = normalizedProvider;
  if (params.model) attrs[traceTypes.ATTR_GEN_AI_REQUEST_MODEL] = params.model;
  const conv = conversationId();
  if (conv) attrs[traceTypes.ATTR_GEN_AI_CONVERSATION_ID] = conv;
  span.setAttributes(attrs);
}

/** The `invoke_workflow` span attributes — LiveKit's session is the workflow. */
export function setWorkflowAttributes(span: Span, params: { name: string }): void {
  if (!span.isRecording()) return;

  const attrs: Attributes = {
    [traceTypes.ATTR_GEN_AI_OPERATION_NAME]: traceTypes.GenAIOperationName.INVOKE_WORKFLOW,
    [traceTypes.ATTR_GEN_AI_WORKFLOW_NAME]: params.name,
  };
  const conv = conversationId();
  if (conv) attrs[traceTypes.ATTR_GEN_AI_CONVERSATION_ID] = conv;
  span.setAttributes(attrs);
}
