// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { beforeAll, describe, expect, it } from 'vitest';
import {
  AgentConfigUpdate,
  AgentHandoffItem,
  ChatContext,
  ChatMessage,
  FunctionCall,
  FunctionCallOutput,
} from '../llm/chat_context.js';
import { type ChatChunk, LLM, LLMStream } from '../llm/llm.js';
import type { ToolChoice, ToolContextLike } from '../llm/tool_context.js';
import { initializeLogger } from '../log.js';
import { type APIConnectOptions, DEFAULT_API_CONNECT_OPTIONS } from '../types.js';
import { EvaluationResult, JudgeGroup } from './evaluation.js';
import {
  type EvaluateOptions,
  Judge,
  JudgmentResult,
  accuracyJudge,
  formatChatCtx,
  handoffJudge,
  taskCompletionJudge,
} from './judge.js';

/** LLM that records each request and answers with a fixed submit_verdict call. */
class VerdictLLM extends LLM {
  readonly requests: {
    chatCtx: ChatContext;
    toolChoice?: ToolChoice;
    extraKwargs?: Record<string, unknown>;
  }[] = [];

  constructor(private readonly args: string | undefined) {
    super();
  }

  label(): string {
    return 'verdict-llm';
  }

  chat({
    chatCtx,
    toolCtx,
    connOptions = DEFAULT_API_CONNECT_OPTIONS,
    toolChoice,
    extraKwargs,
  }: Parameters<LLM['chat']>[0]): LLMStream {
    this.requests.push({ chatCtx, toolChoice, extraKwargs });
    return new VerdictStream(this, { chatCtx, toolCtx, connOptions, args: this.args });
  }
}

class VerdictStream extends LLMStream {
  private readonly args: string | undefined;

  constructor(
    llm: LLM,
    opts: {
      chatCtx: ChatContext;
      toolCtx?: ToolContextLike;
      connOptions: APIConnectOptions;
      args: string | undefined;
    },
  ) {
    super(llm, opts);
    this.args = opts.args;
  }

  protected async run(): Promise<void> {
    const toolCalls =
      this.args === undefined
        ? []
        : [FunctionCall.create({ callId: 'call_1', name: 'submit_verdict', args: this.args })];
    const chunk: ChatChunk = { id: 'test', delta: { role: 'assistant', toolCalls } };
    this.queue.put(chunk);
  }
}

const verdict = (v: string, reasoning = 'because') => JSON.stringify({ verdict: v, reasoning });

/** The user prompt sent to the judge LLM in the given request. */
function promptOf(llm: VerdictLLM, index = 0): string {
  const msg = llm.requests[index]!.chatCtx.items[1] as ChatMessage;
  return msg.textContent ?? '';
}

function conversation(): ChatContext {
  const ctx = ChatContext.empty();
  ctx.insert(new AgentConfigUpdate({ instructions: 'Book a table for the caller.' }));
  ctx.insert(ChatMessage.create({ role: 'user', content: 'Table for two at 7pm, I am Kim.' }));
  ctx.insert(
    FunctionCall.create({ callId: 'c1', name: 'book_table', args: '{"party":2,"time":"19:00"}' }),
  );
  ctx.insert(
    new FunctionCallOutput({ callId: 'c1', name: 'book_table', output: 'ok', isError: false }),
  );
  ctx.insert(ChatMessage.create({ role: 'assistant', content: 'Booked for 7pm, Kim.' }));
  return ctx;
}

beforeAll(() => {
  initializeLogger({ pretty: false, level: 'silent' });
});

describe('formatChatCtx', () => {
  it('formats every item type like the Python implementation', () => {
    const ctx = conversation();
    ctx.insert(new AgentHandoffItem({ oldAgentId: 'a', newAgentId: 'b' }));
    ctx.insert(ChatMessage.create({ role: 'assistant', content: 'Hold on', interrupted: true }));

    expect(formatChatCtx(ctx)).toBe(
      [
        '[agent config: instructions="Book a table for the caller."]',
        'user: Table for two at 7pm, I am Kim.',
        '[function call: book_table({"party":2,"time":"19:00"})]',
        '[function output: ok]',
        'assistant: Booked for 7pm, Kim.',
        '[agent handoff: a -> b]',
        'assistant: Hold on [interrupted]',
      ].join('\n'),
    );
  });
});

describe('LLM judges', () => {
  it('forces the submit_verdict tool and parses the verdict', async () => {
    const llm = new VerdictLLM(verdict('pass', 'grounded in tool output'));
    const result = await accuracyJudge(llm).evaluate({ chatCtx: conversation() });

    expect(llm.requests[0]!.toolChoice).toBe('required');
    expect(llm.requests[0]!.extraKwargs).toEqual({ temperature: 0 });
    expect(result.verdict).toBe('pass');
    expect(result.passed).toBe(true);
    expect(result.reasoning).toBe('grounded in tool output');
    expect(result.instructions).toContain('accurate and grounded');
    expect(promptOf(llm)).toContain('[function output: ok]');
  });

  it('prefers the LLM passed to evaluate over the constructor one', async () => {
    const own = new VerdictLLM(verdict('fail'));
    const given = new VerdictLLM(verdict('maybe'));
    const result = await accuracyJudge(own).evaluate({ chatCtx: conversation(), llm: given });

    expect(result.uncertain).toBe(true);
    expect(own.requests).toHaveLength(0);
  });

  it('throws when no LLM is available', async () => {
    await expect(accuracyJudge().evaluate({ chatCtx: conversation() })).rejects.toThrow(
      /No LLM provided for judge 'accuracy'/,
    );
  });

  it('throws when the LLM returns no verdict', async () => {
    const llm = new VerdictLLM(undefined);
    await expect(accuracyJudge(llm).evaluate({ chatCtx: conversation() })).rejects.toThrow(
      'LLM did not return verdict arguments',
    );
  });

  it('rejects a verdict outside pass/fail/maybe', async () => {
    const llm = new VerdictLLM(verdict('great'));
    await expect(accuracyJudge(llm).evaluate({ chatCtx: conversation() })).rejects.toThrow();
  });

  it('adds the reference conversation without its instructions', async () => {
    const llm = new VerdictLLM(verdict('pass'));
    const reference = ChatContext.empty();
    reference.insert(ChatMessage.create({ role: 'system', content: 'secret system prompt' }));
    reference.insert(ChatMessage.create({ role: 'assistant', content: 'Booked for 7pm.' }));

    await accuracyJudge(llm).evaluate({ chatCtx: conversation(), reference });

    expect(promptOf(llm)).toContain('Reference:\nassistant: Booked for 7pm.');
    expect(promptOf(llm)).not.toContain('secret system prompt');
  });
});

describe('taskCompletionJudge', () => {
  it('includes the latest agent instructions in the prompt', async () => {
    const llm = new VerdictLLM(verdict('pass'));
    const ctx = conversation();
    ctx.insert(new AgentConfigUpdate({ instructions: 'Now take a delivery order.' }));

    const result = await taskCompletionJudge(llm).evaluate({ chatCtx: ctx });

    expect(promptOf(llm)).toContain('Agent Instructions:\nNow take a delivery order.');
    expect(result.instructions).toContain('completed its goal');
  });
});

describe('handoffJudge', () => {
  it('passes without calling the LLM when there is no real handoff', async () => {
    const llm = new VerdictLLM(verdict('fail'));
    const ctx = conversation();
    // The initial agent assignment has no previous agent and is not a handoff.
    ctx.insert(new AgentHandoffItem({ newAgentId: 'a' }));

    const result = await handoffJudge(llm).evaluate({ chatCtx: ctx });

    expect(result.passed).toBe(true);
    expect(llm.requests).toHaveLength(0);
  });

  it('asks the LLM when a handoff happened', async () => {
    const llm = new VerdictLLM(verdict('fail', 'asked the name again'));
    const ctx = conversation();
    ctx.insert(new AgentHandoffItem({ oldAgentId: 'host', newAgentId: 'billing' }));

    const result = await handoffJudge(llm).evaluate({ chatCtx: ctx });

    expect(result.failed).toBe(true);
    expect(promptOf(llm)).toContain('[agent handoff: host -> billing]');
  });
});

class KeywordJudge extends Judge {
  constructor(private readonly keyword: string) {
    super({ name: `keyword_${keyword}` });
  }

  async evaluate({ chatCtx }: EvaluateOptions): Promise<JudgmentResult> {
    const found = chatCtx.items.some(
      (i) => i.type === 'message' && (i.textContent ?? '').includes(this.keyword),
    );
    return new JudgmentResult({ verdict: found ? 'pass' : 'fail', reasoning: this.keyword });
  }
}

describe('Judge', () => {
  it('throws when evaluate is not overridden', async () => {
    const judge = new Judge({ name: 'empty' });
    await expect(judge.evaluate({ chatCtx: conversation() })).rejects.toThrow(
      "Judge 'empty' does not implement evaluate().",
    );
  });
});

describe('JudgeGroup', () => {
  it('runs judges with the group LLM and skips judges that throw', async () => {
    const llm = new VerdictLLM(verdict('maybe'));
    const group = new JudgeGroup({
      llm,
      judges: [
        accuracyJudge(),
        new KeywordJudge('Booked'),
        new KeywordJudge('Cancelled'),
        new Judge({ name: 'broken' }),
      ],
    });

    const result = await group.evaluate(conversation());

    expect(Object.keys(result.judgments).sort()).toEqual([
      'accuracy',
      'keyword_Booked',
      'keyword_Cancelled',
    ]);
    expect(result.judgments.accuracy!.uncertain).toBe(true);
    expect(result.score).toBeCloseTo(0.5);
    expect(result.allPassed).toBe(false);
    expect(result.anyPassed).toBe(true);
    expect(result.majorityPassed).toBe(false);
    expect(result.noneFailed).toBe(false);
  });
});

describe('EvaluationResult', () => {
  const r = (v: 'pass' | 'fail' | 'maybe') => new JudgmentResult({ verdict: v, reasoning: '' });

  it('handles an empty result like the Python implementation', () => {
    const empty = new EvaluationResult();
    expect(empty.score).toBe(0);
    expect(empty.allPassed).toBe(true);
    expect(empty.anyPassed).toBe(false);
    expect(empty.majorityPassed).toBe(true);
    expect(empty.noneFailed).toBe(true);
  });

  it('counts maybe as half a pass and not as a failure', () => {
    const result = new EvaluationResult({ a: r('pass'), b: r('maybe'), c: r('pass') });
    expect(result.score).toBeCloseTo(2.5 / 3);
    expect(result.majorityPassed).toBe(true);
    expect(result.noneFailed).toBe(true);
    expect(result.allPassed).toBe(false);
  });
});
