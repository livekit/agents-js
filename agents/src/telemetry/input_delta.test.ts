// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { Span } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AgentConfigUpdate,
  ChatContext,
  type ChatItem,
  ChatMessage,
  type ChatRole,
  FunctionCall,
  FunctionCallOutput,
  chatItemFingerprint,
} from '../llm/chat_context.js';
import { FallbackAdapter } from '../llm/fallback_adapter.js';
import type { LLM } from '../llm/llm.js';
import { RUNNING_TOOL_PLACEHOLDER_KEY, _injectRunningToolCalls } from '../voice/generation.js';
import { FakeLLM } from '../voice/testing/fake_llm.js';
import * as genAI from './gen_ai.js';
import {
  type InputDelta,
  type InputDeltaScope,
  type InputDeltaSite,
  InputDeltaTracker,
  LLM_NODE,
  LLM_REQUEST,
  runWithScope,
  setAttributes,
} from './input_delta.js';
import * as traceTypes from './trace_types.js';
import { tracer as frameworkTracer, setTracerProvider } from './traces.js';

type MessageSpec = readonly [id: string, role: ChatRole, text: string];
type ContextItem = MessageSpec | ChatItem;

const INSTRUCTIONS_ID = 'lk.agent_task.instructions';
const INSTRUCTIONS = [INSTRUCTIONS_ID, 'system', 'be brief'] as const satisfies MessageSpec;
const CHANGED_INSTRUCTIONS = [
  INSTRUCTIONS_ID,
  'system',
  'be detailed',
] as const satisfies MessageSpec;

function call(id: string, callId: string, createdAt?: number): FunctionCall {
  return new FunctionCall({ id, callId, name: 'f', args: '{}', createdAt });
}

function output(id: string, callId: string, createdAt?: number): FunctionCallOutput {
  return new FunctionCallOutput({
    id,
    callId,
    name: 'f',
    output: 'ok',
    isError: false,
    createdAt,
  });
}

function context(...items: ContextItem[]): ChatContext {
  return new ChatContext(
    items.map((item) =>
      Array.isArray(item)
        ? new ChatMessage({ id: item[0], role: item[1], content: item[2] })
        : (item as ChatItem),
    ),
  );
}

function ids(items: readonly ChatItem[]): string[] {
  return items.map((item) => item.id);
}

describe('input delta tracking', () => {
  let exporter: InMemorySpanExporter;
  let provider: BasicTracerProvider;
  let tracer: ReturnType<BasicTracerProvider['getTracer']>;
  let originalProvider: ReturnType<typeof frameworkTracer.getProvider>;

  beforeEach(() => {
    originalProvider = frameworkTracer.getProvider();
    exporter = new InMemorySpanExporter();
    provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    tracer = provider.getTracer('input-delta-test');
    setTracerProvider(provider);
  });

  afterEach(async () => {
    setTracerProvider(originalProvider);
    await provider.shutdown();
  });

  function delta(
    scope: InputDeltaScope,
    chatCtx: ChatContext,
    site: InputDeltaSite = LLM_REQUEST,
  ): [InputDelta, Span] {
    const span = tracer.startSpan(site.name);
    return [scope.delta(site, chatCtx, span), span];
  }

  function committed(tracker: InputDeltaTracker, chatCtx: ChatContext): Map<string, Span> {
    const scope = tracker.begin();
    const spans = new Map<string, Span>();
    for (const site of [LLM_NODE, LLM_REQUEST]) {
      const [, span] = delta(scope, chatCtx, site);
      spans.set(site.name, span);
      span.end();
    }
    scope.commit();
    return spans;
  }

  async function request(llm: LLM, chatCtx: ChatContext, tracker?: InputDeltaTracker) {
    if (!tracker) {
      await llm.chat({ chatCtx }).collect();
      return;
    }

    const scope = tracker.begin();
    await runWithScope(scope, () => llm.chat({ chatCtx }).collect());
    scope.commit();
  }

  function requestSpans(): ReadableSpan[] {
    return exporter.getFinishedSpans().filter((span) => span.name === LLM_REQUEST.name);
  }

  function inputRoles(span: ReadableSpan): string[] {
    const messages = JSON.parse(
      String(span.attributes[traceTypes.ATTR_GEN_AI_INPUT_MESSAGES]),
    ) as Array<{ role: string }>;
    return messages.map((message) => message.role);
  }

  it('records the first generation in full at both sites', () => {
    const tracker = new InputDeltaTracker();
    const chatCtx = context(INSTRUCTIONS, ['u1', 'user', 'hi']);

    for (const site of [LLM_NODE, LLM_REQUEST]) {
      const [record, span] = delta(tracker.begin(), chatCtx, site);
      expect(record.base).toBeUndefined();
      expect(ids(record.chatCtx.items)).toEqual([INSTRUCTIONS_ID, 'u1']);
      expect(ids(record.instructions)).toEqual([INSTRUCTIONS_ID]);
      span.end();
    }
  });

  it('continues an appended turn from each site parent and records span linkage', () => {
    const tracker = new InputDeltaTracker();
    const parent = committed(tracker, context(INSTRUCTIONS, ['u1', 'user', 'hi']));
    const chatCtx = context(
      INSTRUCTIONS,
      ['u1', 'user', 'hi'],
      ['a1', 'assistant', 'hello'],
      ['u2', 'user', 'bye'],
    );
    const scope = tracker.begin();

    const [node, nodeSpan] = delta(scope, chatCtx, LLM_NODE);
    expect(node.base).toEqual(parent.get(LLM_NODE.name)!.spanContext());
    expect(node.droppedFromBase).toBe(0);
    expect(ids(node.chatCtx.items)).toEqual(['a1', 'u2']);
    nodeSpan.end();

    const [request, requestSpan] = delta(scope, chatCtx, LLM_REQUEST);
    expect(request.base).toEqual(parent.get(LLM_REQUEST.name)!.spanContext());
    expect(request.droppedFromBase).toBe(0);
    expect(request.instructions).toEqual([]);
    expect(ids(request.conversation)).toEqual(['a1', 'u2']);
    setAttributes(requestSpan, request);
    requestSpan.end();

    const exported = exporter
      .getFinishedSpans()
      .find((span) => span.spanContext().spanId === requestSpan.spanContext().spanId)!;
    expect(exported.attributes).toMatchObject({
      [traceTypes.ATTR_INPUT_DELTA]: true,
      [traceTypes.ATTR_INPUT_BASE_SPAN_ID]: parent.get(LLM_REQUEST.name)!.spanContext().spanId,
      [traceTypes.ATTR_INPUT_DROPPED_FROM_BASE]: 0,
    });
    expect(exported.links.map((link) => link.context.spanId)).toEqual([
      parent.get(LLM_REQUEST.name)!.spanContext().spanId,
    ]);
  });

  it('records changed instructions separately for requests but restarts node input', () => {
    const tracker = new InputDeltaTracker();
    committed(tracker, context(INSTRUCTIONS, ['u1', 'user', 'hi']));
    const chatCtx = context(CHANGED_INSTRUCTIONS, ['u1', 'user', 'hi'], ['u2', 'user', 'bye']);
    const scope = tracker.begin();

    const [request, requestSpan] = delta(scope, chatCtx, LLM_REQUEST);
    expect(request.base).toBeDefined();
    expect(request.droppedFromBase).toBe(0);
    expect(ids(request.instructions)).toEqual([INSTRUCTIONS_ID]);
    expect(ids(request.conversation)).toEqual(['u2']);
    requestSpan.end();

    const [node, nodeSpan] = delta(scope, chatCtx, LLM_NODE);
    expect(node.base).toBeUndefined();
    expect(ids(node.chatCtx.items)).toEqual([INSTRUCTIONS_ID, 'u1', 'u2']);
    nodeSpan.end();
  });

  it('records from an edited item and drops the old suffix', () => {
    const tracker = new InputDeltaTracker();
    committed(
      tracker,
      context(INSTRUCTIONS, ['u1', 'user', 'hi'], ['a1', 'assistant', 'hey'], ['u2', 'user', 'x']),
    );
    const chatCtx = context(
      INSTRUCTIONS,
      ['u1', 'user', 'hi'],
      ['a1', 'assistant', 'HEY'],
      ['u2', 'user', 'x'],
    );

    const [request, span] = delta(tracker.begin(), chatCtx);
    expect(request.droppedFromBase).toBe(2);
    expect(ids(request.conversation)).toEqual(['a1', 'u2']);
    span.end();
  });

  it('never splits a tool call from its assistant message', () => {
    const tracker = new InputDeltaTracker();
    committed(
      tracker,
      context(INSTRUCTIONS, ['u1', 'user', 'hi'], ['a1', 'assistant', 'checking']),
    );
    const chatCtx = context(
      INSTRUCTIONS,
      ['u1', 'user', 'hi'],
      ['a1', 'assistant', 'checking'],
      call('fc', 'c1'),
      output('fo', 'c1'),
    );

    const [request, span] = delta(tracker.begin(), chatCtx);
    expect(request.droppedFromBase).toBe(1);
    expect(ids(request.conversation)).toEqual(['a1', 'fc', 'fo']);
    expect(request.inputMessages().map((message) => message.role)).toEqual(['assistant', 'tool']);
    span.end();
  });

  it('keeps a tool call with its message across a skipped AgentConfigUpdate', () => {
    const tracker = new InputDeltaTracker();
    const config = new AgentConfigUpdate({ id: 'cfg', toolsAdded: ['f'] });
    const parentCtx = context(
      INSTRUCTIONS,
      ['u1', 'user', 'hi'],
      ['a1', 'assistant', 'checking'],
      config,
    );
    const parent = committed(tracker, parentCtx);
    const chatCtx = context(...parentCtx.items, call('fc', 'c1'), output('fo', 'c1'));

    const [request, span] = delta(tracker.begin(), chatCtx);
    expect(request.base).toEqual(parent.get(LLM_REQUEST.name)!.spanContext());
    expect(request.droppedFromBase).toBe(1);
    expect(ids(request.conversation)).toEqual(['a1', 'cfg', 'fc', 'fo']);

    const parentMessages = genAI.toInputMessages(parentCtx);
    const rebuilt = [
      ...parentMessages.slice(0, parentMessages.length - 1),
      ...request.inputMessages(),
    ];
    expect(rebuilt).toEqual(genAI.toInputMessages(chatCtx));
    span.end();
  });

  it('shares stable running placeholders and replaces them when the tool ends', () => {
    const message = (id: string, role: ChatRole, createdAt: number) =>
      new ChatMessage({ id, role, content: id, createdAt });
    const running = call('rc', 'c1', 2.5);
    const history: ChatItem[] = [
      message(INSTRUCTIONS_ID, 'system', 0),
      message('u1', 'user', 2),
      message('a1', 'assistant', 3),
    ];
    const turn = (items: ChatItem[], stillRunning: boolean): ChatContext => {
      const chatCtx = new ChatContext([...history, ...items]);
      if (stillRunning) _injectRunningToolCalls(chatCtx, [running]);
      return chatCtx;
    };
    const tracker = new InputDeltaTracker();
    committed(tracker, turn([message('u2', 'user', 4)], true));

    const chatCtx = turn(
      [message('u2', 'user', 4), message('a2', 'assistant', 5), message('u3', 'user', 6)],
      true,
    );
    const scope = tracker.begin();
    const [stable, stableSpan] = delta(scope, chatCtx, LLM_NODE);
    scope.commit();
    expect(stable.droppedFromBase).toBe(0);
    expect(ids(stable.chatCtx.items)).toEqual(['a2', 'u3']);
    stableSpan.end();

    const finished = new FunctionCallOutput({
      id: 'ro',
      callId: 'c1',
      name: 'f',
      output: 'done',
      isError: false,
      createdAt: 2.6,
    });
    const finishedCtx = turn(
      [
        running,
        finished,
        message('u2', 'user', 4),
        message('a2', 'assistant', 5),
        message('u3', 'user', 6),
        message('u4', 'user', 7),
      ],
      false,
    );
    finishedCtx.items.sort((left, right) => left.createdAt - right.createdAt);
    const [replaced, replacedSpan] = delta(tracker.begin(), finishedCtx, LLM_NODE);
    expect(replaced.chatCtx.items[0]!.id).toBe('rc');
    expect(
      replaced.chatCtx.items.some(
        (item) =>
          item.type === 'function_call' && item.extra[RUNNING_TOOL_PLACEHOLDER_KEY] === true,
      ),
    ).toBe(false);
    replacedSpan.end();
  });

  it('does not move the parent for an uncommitted generation', () => {
    const tracker = new InputDeltaTracker();
    const parent = committed(tracker, context(INSTRUCTIONS, ['u1', 'user', 'hi']));
    const [, discardedSpan] = delta(
      tracker.begin(),
      context(INSTRUCTIONS, ['u1', 'user', 'hi'], ['p2', 'user', 'by']),
    );
    discardedSpan.end();

    const [request, span] = delta(
      tracker.begin(),
      context(INSTRUCTIONS, ['u1', 'user', 'hi'], ['u2', 'user', 'bye']),
    );
    expect(request.base).toEqual(parent.get(LLM_REQUEST.name)!.spanContext());
    expect(ids(request.conversation)).toEqual(['u2']);
    span.end();
  });

  it('promotes a span created after its scope was committed', () => {
    const tracker = new InputDeltaTracker();
    const scope = tracker.begin();
    scope.commit();
    const [, firstSpan] = delta(scope, context(INSTRUCTIONS, ['u1', 'user', 'hi']));
    firstSpan.end();

    const [request, span] = delta(
      tracker.begin(),
      context(INSTRUCTIONS, ['u1', 'user', 'hi'], ['u2', 'user', 'x']),
    );
    expect(request.base).toEqual(firstSpan.spanContext());
    span.end();
  });

  it('keeps tracker baselines independent', () => {
    const first = new InputDeltaTracker();
    const second = new InputDeltaTracker();
    committed(first, context(INSTRUCTIONS, ['u1', 'user', 'hi']));

    const [request, span] = delta(
      second.begin(),
      context(INSTRUCTIONS, ['u1', 'user', 'hi'], ['u2', 'user', 'x']),
    );
    expect(request.base).toBeUndefined();
    span.end();
  });

  it('executes the expressive-mode incremental example', () => {
    const u1 = ['u1', 'user', 'hi'] as const satisfies MessageSpec;
    const a1 = ['a1', 'assistant', 'hello'] as const satisfies MessageSpec;
    const u2 = ['u2', 'user', 'x'] as const satisfies MessageSpec;
    const a2 = ['a2', 'assistant', 'sure'] as const satisfies MessageSpec;
    const u3 = ['u3', 'user', 'weather?'] as const satisfies MessageSpec;
    const guide = ['G', 'system', 'markup guide'] as const satisfies MessageSpec;
    const tool: ChatItem[] = [call('fc', 'c1'), output('fo', 'c1')];
    const turns = [
      context(INSTRUCTIONS, u1, guide),
      context(INSTRUCTIONS, u1, a1, u2, guide),
      context(INSTRUCTIONS, u1, a1, u2, a2, u3, guide),
      context(INSTRUCTIONS, u1, a1, u2, a2, u3, guide, ...tool),
    ];
    const expected: Array<[string[], number | undefined]> = [
      [[INSTRUCTIONS_ID, 'u1', 'G'], undefined],
      [['a1', 'u2', 'G'], 1],
      [['a2', 'u3', 'G'], 1],
      [['fc', 'fo'], 0],
    ];
    const tracker = new InputDeltaTracker();

    turns.forEach((chatCtx, index) => {
      const scope = tracker.begin();
      const [record, span] = delta(scope, chatCtx, LLM_NODE);
      scope.commit();
      expect(ids(record.chatCtx.items)).toEqual(expected[index]![0]);
      expect(record.droppedFromBase).toBe(expected[index]![1]);
      span.end();
    });
  });

  it('recursively reconstructs node chat items, GenAI messages, and inherited instructions', () => {
    const turn = (...items: ContextItem[]): ChatContext => {
      const chatCtx = context(...items, ['G', 'system', 'markup guide']);
      const configIndex = chatCtx.items[0]?.id === INSTRUCTIONS_ID ? 1 : 0;
      chatCtx.items.splice(
        configIndex,
        0,
        new AgentConfigUpdate({ id: 'cfg', instructions: 'initial' }),
      );
      return chatCtx;
    };
    const a1 = ['a1', 'assistant', 'hello'] as const satisfies MessageSpec;
    const u1 = ['u1', 'user', 'hi'] as const satisfies MessageSpec;
    const a2 = ['a2', 'assistant', 'sure'] as const satisfies MessageSpec;
    const u2 = ['u2', 'user', 'weather?'] as const satisfies MessageSpec;
    const a3 = ['a3', 'assistant', 'sunny'] as const satisfies MessageSpec;
    const u3 = ['u3', 'user', 'tomorrow?'] as const satisfies MessageSpec;
    const a4 = ['a4', 'assistant', 'rain'] as const satisfies MessageSpec;
    const u4 = ['u4', 'user', 'thanks'] as const satisfies MessageSpec;
    const persistent = ['S', 'system', 'doctor has slots at 3pm'] as const satisfies MessageSpec;
    const tool: ChatItem[] = [call('fc', 'c1'), output('fo', 'c1')];
    const toolTurn = turn(INSTRUCTIONS, a1, u1, a2, u2);
    const turns = [
      turn(INSTRUCTIONS, ['x', 'system', 'greet the user']),
      turn(INSTRUCTIONS, a1, u1),
      turn(INSTRUCTIONS, a1, u1, a2, u2),
      context(...toolTurn.items, ...tool),
      turn(INSTRUCTIONS, a1, u1, a2, u2, ...tool, persistent, a3, u3, [
        'R',
        'assistant',
        'rag: docs',
      ]),
      turn(INSTRUCTIONS, a1, u1, a2, u2, ...tool, persistent, a3, u3, a4, u4, [
        'R2',
        'assistant',
        'rag: more',
      ]),
      turn(CHANGED_INSTRUCTIONS, a1, u1, a2, u2, ...tool, persistent, a3, u3, a4, u4, [
        'a5',
        'assistant',
        'ok',
      ]),
      turn(
        CHANGED_INSTRUCTIONS,
        a1,
        ['u1', 'user', 'hey'],
        a2,
        u2,
        ...tool,
        persistent,
        a3,
        u3,
        a4,
        u4,
      ),
      context(['sp', 'system', 'you are a bot'], ['G', 'system', 'guide'], u1),
    ];
    const tracker = new InputDeltaTracker();
    const recorded = new Map<string, InputDelta>();
    const shape: Record<string, Array<[boolean, boolean]>> = {
      [LLM_NODE.name]: [],
      [LLM_REQUEST.name]: [],
    };

    const parent = (record: InputDelta): InputDelta => {
      expect(record.base).toBeDefined();
      return recorded.get(record.base!.spanId)!;
    };
    const kept = <T>(entries: T[], dropped: number): T[] =>
      entries.slice(0, entries.length - dropped);
    const chatItems = (record: InputDelta): ChatItem[] =>
      record.droppedFromBase === undefined
        ? [...record.chatCtx.items]
        : [...kept(chatItems(parent(record)), record.droppedFromBase), ...record.chatCtx.items];
    const messages = (record: InputDelta): genAI.ChatMessagePayload[] =>
      record.droppedFromBase === undefined
        ? record.inputMessages()
        : [...kept(messages(parent(record)), record.droppedFromBase), ...record.inputMessages()];
    const instructions = (record: InputDelta): genAI.MessagePart[] =>
      record.instructions.length > 0 || !record.base
        ? record.systemInstructions()
        : instructions(parent(record));

    for (const chatCtx of turns) {
      const scope = tracker.begin();
      const latest = new Map<string, InputDelta>();
      for (const site of [LLM_NODE, LLM_REQUEST]) {
        const [record, span] = delta(scope, chatCtx, site);
        recorded.set(span.spanContext().spanId, record);
        latest.set(site.name, record);
        shape[site.name]!.push([record.base !== undefined, record.instructions.length > 0]);
        span.end();
      }
      scope.commit();

      expect(
        chatItems(latest.get(LLM_NODE.name)!).map((item) => [item.id, chatItemFingerprint(item)]),
      ).toEqual(chatCtx.items.map((item) => [item.id, chatItemFingerprint(item)]));
      expect(messages(latest.get(LLM_REQUEST.name)!)).toEqual(genAI.toInputMessages(chatCtx));
      expect(instructions(latest.get(LLM_REQUEST.name)!)).toEqual(
        genAI.toSystemInstructions(chatCtx),
      );
      expect(instructions(latest.get(LLM_REQUEST.name)!)).toHaveLength(1);
    }

    expect(shape[LLM_REQUEST.name]).toEqual([
      [false, true],
      [true, false],
      [true, false],
      [true, false],
      [true, false],
      [true, false],
      [true, true],
      [true, false],
      [false, true],
    ]);
    expect(shape[LLM_NODE.name]!.map(([hasBase]) => hasBase)).toEqual([
      false,
      true,
      true,
      true,
      true,
      true,
      false,
      true,
      false,
    ]);
  });

  it('records successive LLMStream requests as a full input followed by deltas', async () => {
    const tracker = new InputDeltaTracker();
    const llm = new FakeLLM();
    await request(llm, context(INSTRUCTIONS, ['u1', 'user', 'Hello']), tracker);
    await request(
      llm,
      context(
        INSTRUCTIONS,
        ['u1', 'user', 'Hello'],
        ['a1', 'assistant', 'Hi there'],
        ['u2', 'user', "What's the weather in Tokyo?"],
      ),
      tracker,
    );
    await request(
      llm,
      context(
        INSTRUCTIONS,
        ['u1', 'user', 'Hello'],
        ['a1', 'assistant', 'Hi there'],
        ['u2', 'user', "What's the weather in Tokyo?"],
        call('fc', 'c1'),
        output('fo', 'c1'),
      ),
      tracker,
    );

    const [first, second, toolStep] = requestSpans();
    expect(requestSpans()).toHaveLength(3);
    expect(first!.attributes[traceTypes.ATTR_INPUT_DELTA]).toBeUndefined();
    expect(first!.attributes[traceTypes.ATTR_GEN_AI_SYSTEM_INSTRUCTIONS]).toBeDefined();
    expect(inputRoles(first!)).toEqual(['user']);

    expect(second!.attributes).toMatchObject({
      [traceTypes.ATTR_INPUT_DELTA]: true,
      [traceTypes.ATTR_INPUT_BASE_SPAN_ID]: first!.spanContext().spanId,
      [traceTypes.ATTR_INPUT_DROPPED_FROM_BASE]: 0,
    });
    expect(second!.attributes[traceTypes.ATTR_GEN_AI_SYSTEM_INSTRUCTIONS]).toBeUndefined();
    expect(inputRoles(second!)).toEqual(['assistant', 'user']);
    expect(second!.links.map((link) => link.context.spanId)).toEqual([first!.spanContext().spanId]);

    expect(toolStep!.attributes).toMatchObject({
      [traceTypes.ATTR_INPUT_DELTA]: true,
      [traceTypes.ATTR_INPUT_BASE_SPAN_ID]: second!.spanContext().spanId,
      [traceTypes.ATTR_INPUT_DROPPED_FROM_BASE]: 0,
    });
    expect(inputRoles(toolStep!)).toEqual(['assistant', 'tool']);
  });

  it('records full LLMStream request inputs when input delta is off', async () => {
    const llm = new FakeLLM();
    await request(llm, context(INSTRUCTIONS, ['u1', 'user', 'Hello']));
    await request(
      llm,
      context(
        INSTRUCTIONS,
        ['u1', 'user', 'Hello'],
        ['a1', 'assistant', 'Hi there'],
        ['u2', 'user', 'Weather?'],
      ),
    );

    const spans = requestSpans();
    expect(spans).toHaveLength(2);
    for (const span of spans) {
      expect(Object.keys(span.attributes).some((key) => key.startsWith('lk.input.'))).toBe(false);
      expect(span.attributes[traceTypes.ATTR_GEN_AI_SYSTEM_INSTRUCTIONS]).toBeDefined();
    }
    expect(inputRoles(spans[1]!)).toEqual(['user', 'assistant', 'user']);
  });

  it('records fallback input only on provider spans and chains provider deltas', async () => {
    const tracker = new InputDeltaTracker();
    const llm = new FallbackAdapter({ llms: [new FakeLLM()] });
    await request(llm, context(INSTRUCTIONS, ['u1', 'user', 'Hello']), tracker);
    await request(
      llm,
      context(
        INSTRUCTIONS,
        ['u1', 'user', 'Hello'],
        ['a1', 'assistant', 'Hi there'],
        ['u2', 'user', 'Weather?'],
      ),
      tracker,
    );

    const spans = requestSpans();
    const providerSpans = spans.filter(
      (span) => traceTypes.ATTR_GEN_AI_INPUT_MESSAGES in span.attributes,
    );
    const wrapperSpans = spans.filter(
      (span) => !(traceTypes.ATTR_GEN_AI_INPUT_MESSAGES in span.attributes),
    );
    expect(spans).toHaveLength(4);
    expect(providerSpans).toHaveLength(2);
    expect(wrapperSpans).toHaveLength(2);
    expect(
      providerSpans.map((span) => span.attributes[traceTypes.ATTR_GEN_AI_OPERATION_NAME]),
    ).toEqual(['chat', 'chat']);
    expect(
      wrapperSpans.every((span) =>
        Object.keys(span.attributes).every((key) => !key.startsWith('lk.input.')),
      ),
    ).toBe(true);
    expect(providerSpans[1]!.attributes[traceTypes.ATTR_INPUT_BASE_SPAN_ID]).toBe(
      providerSpans[0]!.spanContext().spanId,
    );
    expect(providerSpans[1]!.links.map((link) => link.context.spanId)).toEqual([
      providerSpans[0]!.spanContext().spanId,
    ]);
    expect(wrapperSpans.map((span) => span.spanContext().spanId)).not.toContain(
      providerSpans[1]!.attributes[traceTypes.ATTR_INPUT_BASE_SPAN_ID],
    );
  });
});
