// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { Span } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-node';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ChatContext, FunctionCall, FunctionCallOutput } from '../llm/chat_context.js';
import { tool } from '../llm/tool_context.js';
import * as genAI from './gen_ai.js';
import * as traceTypes from './trace_types.js';

// The shapes asserted here follow the gen_ai.input.messages / output.messages /
// system_instructions / tool.definitions JSON schemas from
// https://github.com/open-telemetry/semantic-conventions-genai, so builder drift is
// caught here rather than by a backend that silently drops the span.

function chatContext(): ChatContext {
  const ctx = ChatContext.empty();
  ctx.addMessage({ role: 'system', content: 'You are a helpful agent.' });
  ctx.addMessage({ role: 'user', content: "What's the weather in Paris?" });
  ctx.insert(new FunctionCall({ callId: 'call_1', name: 'get_weather', args: '{"loc": "Paris"}' }));
  ctx.insert(
    new FunctionCallOutput({
      callId: 'call_1',
      name: 'get_weather',
      output: '{"temp": 14}',
      isError: false,
    }),
  );
  ctx.addMessage({ role: 'assistant', content: "It's 14 degrees in Paris." });
  return ctx;
}

function exportingSpan(name = 'llm_request'): { span: Span; exporter: InMemorySpanExporter } {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  return { span: provider.getTracer('test').startSpan(name), exporter };
}

afterEach(() => {
  genAI.setCaptureContent(true);
});

describe('gen_ai builders', () => {
  it("produces the convention's shapes", () => {
    const ctx = chatContext();

    // instructions are reported separately from history, not as a system message
    expect(genAI.toSystemInstructions(ctx)).toEqual([
      { type: 'text', content: 'You are a helpful agent.' },
    ]);

    const messages = genAI.toInputMessages(ctx);
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(messages[1]!.parts[0]).toEqual({
      type: 'tool_call',
      id: 'call_1',
      name: 'get_weather',
      arguments: { loc: 'Paris' },
    });
    // a serialized payload is deserialized, as the convention asks of instrumentations
    expect(messages[2]!.parts[0]!.response).toEqual({ temp: 14 });

    const output = genAI.toOutputMessages({
      text: 'one moment',
      functionCalls: [{ callId: 'call_9', name: 'lookup', args: '{"q": "x"}' }],
    });
    expect(output[0]!.role).toBe('assistant');
    expect(output[0]!.parts.map((p) => p.type)).toEqual(['text', 'tool_call']);
    expect(genAI.toOutputMessages({ text: '' })).toEqual([]);

    const getWeather = tool({
      name: 'get_weather',
      description: 'Get the current weather in a given location',
      parameters: z.object({ location: z.string() }),
      execute: async () => 'sunny',
    });
    // `parameters` is omitted: the convention marks it NOT RECOMMENDED by default
    expect(genAI.toToolDefinitions([getWeather])).toEqual([
      {
        type: 'function',
        name: 'get_weather',
        description: 'Get the current weather in a given location',
      },
    ]);
  });

  it("uses the convention's finish-reason values", () => {
    expect(genAI.finishReasonFor({})).toBe('stop');
    expect(genAI.finishReasonFor({ interrupted: true })).toBe('error');
    expect(genAI.finishReasonFor({ functionCalls: [{}] })).toBe('tool_call');
    // a tool call emitted before the generation failed is not a successful handoff
    expect(genAI.finishReasonFor({ functionCalls: [{}], interrupted: true })).toBe('error');
  });
});

describe('gen_ai span attributes', () => {
  it('uses the registry names on an inference span', () => {
    const { span, exporter } = exportingSpan();
    genAI.setRequestAttributes(span, {
      operation: traceTypes.GenAIOperationName.CHAT,
      // a LiveKit plugin id, normalized to the registry spelling
      provider: 'bedrock',
      model: 'claude-sonnet-4',
      stream: true,
    });
    genAI.setResponseAttributes(span, {
      responseId: 'resp_1',
      finishReasons: ['stop'],
      timeToFirstChunk: 0.4,
    });
    genAI.setContentAttributes(span, { inputMessages: [{ role: 'user', parts: [] }] });
    span.end();

    const attrs = exporter.getFinishedSpans()[0]!.attributes;
    expect(attrs['gen_ai.operation.name']).toBe('chat');
    expect(attrs['gen_ai.provider.name']).toBe('aws.bedrock');
    expect(attrs['gen_ai.request.model']).toBe('claude-sonnet-4');
    expect(attrs['gen_ai.request.stream']).toBe(true);
    expect(attrs['gen_ai.response.id']).toBe('resp_1');
    expect(attrs['gen_ai.response.finish_reasons']).toEqual(['stop']);
    expect(attrs['gen_ai.response.time_to_first_chunk']).toBe(0.4);
    // attributes cannot hold structured values, so content is a JSON string
    expect(JSON.parse(attrs['gen_ai.input.messages'] as string)).toEqual([
      { role: 'user', parts: [] },
    ]);
  });

  it('omits content but keeps metadata when content capture is off', () => {
    const { span, exporter } = exportingSpan();
    genAI.setCaptureContent(false);
    genAI.setRequestAttributes(span, {
      operation: traceTypes.GenAIOperationName.CHAT,
      model: 'gpt-4o',
    });
    genAI.setContentAttributes(span, { inputMessages: [{ role: 'user', parts: [] }] });
    span.end();

    const attrs = exporter.getFinishedSpans()[0]!.attributes;
    expect(attrs['gen_ai.input.messages']).toBeUndefined();
    expect(attrs['gen_ai.request.model']).toBe('gpt-4o');
  });

  it('reports usage details alongside the totals, never added to them', () => {
    const { span, exporter } = exportingSpan();
    genAI.setUsageAttributes(span, {
      promptTokens: 300,
      completionTokens: 180,
      promptCachedTokens: 40,
      cacheCreationTokens: 25,
      reasoningTokens: 50,
    });
    span.end();

    const attrs = exporter.getFinishedSpans()[0]!.attributes;
    expect(attrs['gen_ai.usage.input_tokens']).toBe(300);
    expect(attrs['gen_ai.usage.output_tokens']).toBe(180);
    expect(attrs['gen_ai.usage.cache_read.input_tokens']).toBe(40);
    // both spellings, so the pipeline and realtime paths agree
    expect(attrs['gen_ai.usage.input_cached_tokens']).toBe(40);
    expect(attrs['gen_ai.usage.cache_write.input_tokens']).toBe(25);
    expect(attrs['gen_ai.usage.reasoning.output_tokens']).toBe(50);
  });

  it('describes a tool execution as the execute_tool span', () => {
    const { span, exporter } = exportingSpan('function_tool');
    genAI.setToolAttributes(span, {
      name: 'get_weather',
      callId: 'call_1',
      description: 'Get the weather',
      args: '{"location": "Paris"}',
    });
    genAI.setToolResult(span, { result: '{"temp": 14}', isError: false });
    span.end();

    const attrs = exporter.getFinishedSpans()[0]!.attributes;
    expect(attrs['gen_ai.operation.name']).toBe('execute_tool');
    expect(attrs['gen_ai.tool.name']).toBe('get_weather');
    expect(attrs['gen_ai.tool.call.id']).toBe('call_1');
    expect(attrs['gen_ai.tool.type']).toBe('function');
    expect(JSON.parse(attrs['gen_ai.tool.call.arguments'] as string)).toEqual({
      location: 'Paris',
    });
    expect(JSON.parse(attrs['gen_ai.tool.call.result'] as string)).toEqual({ temp: 14 });
  });

  it('keeps error.type low-cardinality', () => {
    const failed = exportingSpan('function_tool');
    genAI.setToolResult(failed.span, { result: 'boom', isError: true });
    failed.span.end();
    const toolAttrs = failed.exporter.getFinishedSpans()[0]!.attributes;
    // "the result returned by the tool call (if any and if execution was successful)"
    expect(toolAttrs['gen_ai.tool.call.result']).toBeUndefined();
    expect(toolAttrs['error.type']).toBe('tool_error');

    const errored = exportingSpan();
    genAI.setErrorType(errored.span, Object.assign(new Error('rate limited'), { statusCode: 429 }));
    errored.span.end();
    // a status code identifies the failure better than the error class
    expect(errored.exporter.getFinishedSpans()[0]!.attributes['error.type']).toBe('429');
  });
});

// Every `provider` value a plugin actually reports. The convention makes the registry
// spelling mandatory for a provider it enumerates, so a plugin returning a display name or a
// base-URL host must still land on it.
describe('provider normalization', () => {
  it.each([
    // base-URL hosts, from the OpenAI-compatible clients
    ['api.openai.com', 'openai'],
    ['api.anthropic.com', 'anthropic'],
    ['api.mistral.ai', 'mistral_ai'],
    ['api.groq.com', 'groq'],
    ['api.x.ai', 'x_ai'],
    ['my-co.openai.azure.com', 'azure.ai.openai'],
    ['bedrock-runtime.us-east-1.amazonaws.com', 'aws.bedrock'],
    // display names
    ['AWS Bedrock', 'aws.bedrock'],
    ['Amazon', 'aws.bedrock'],
    ['MistralAI', 'mistral_ai'],
    ['Vertex AI', 'gcp.vertex_ai'],
    ['Vertex AI Model Garden', 'gcp.vertex_ai'],
    ['Gemini', 'gcp.gemini'],
    ['google', 'gcp.gen_ai'],
    ['xAI', 'x_ai'],
    ['xai', 'x_ai'],
    ['Perplexity', 'perplexity'],
    // outside the registry: the convention allows a custom value, so it passes through
    ['MiniMax', 'MiniMax'],
    ['api.cerebras.ai', 'api.cerebras.ai'],
  ])('resolves %s', (reported, expected) => {
    expect(traceTypes.genAIProviderName(reported as string)).toBe(expected);
  });

  it('only targets registry values', () => {
    // a typo in a mapping would emit a value no backend recognises
    const { byHost, byHostSuffix, byName } = traceTypes._providerTables;
    const targets = [
      ...Object.values(byHost),
      ...Object.values(byName),
      ...byHostSuffix.map(([, v]) => v),
    ];
    expect(targets.filter((t) => !traceTypes.GEN_AI_PROVIDER_NAMES.has(t))).toEqual([]);
  });
});
