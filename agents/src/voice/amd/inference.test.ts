// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/** Ported from Python `tests/test_amd_inference.py`: AMD structured model calls and validation. */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../../llm/chat_context.js';
import { ChatContext, FunctionCall } from '../../llm/chat_context.js';
import { FallbackAdapter } from '../../llm/fallback_adapter.js';
import { LLM, LLMStream } from '../../llm/llm.js';
import {
  type FunctionTool,
  type ToolChoice,
  type ToolContextLike,
  toToolContext,
} from '../../llm/tool_context.js';
import { toJsonSchema } from '../../llm/utils.js';
import { initializeLogger } from '../../log.js';
import { type APIConnectOptions, DEFAULT_API_CONNECT_OPTIONS } from '../../types.js';
import type { AMDRequest } from './chat_context.js';
import { AMDCategory } from './events.js';
import * as fsm from './fsm.js';
import {
  AMDResponseError,
  CLASSIFY_PROMPT,
  MENU_PROMPT,
  classify,
  extractIvrMenu,
} from './inference.js';

initializeLogger({ pretty: false, level: 'silent' });

// pydantic `model_json_schema()` of the Python response models
const AMD_RESPONSE_SCHEMA = {
  $defs: {
    AMDCategory: {
      enum: [
        'human',
        'machine-ivr',
        'machine-screening',
        'machine-vm',
        'machine-unavailable',
        'wait',
        'uncertain',
      ],
      title: 'AMDCategory',
      type: 'string',
    },
  },
  properties: { category: { $ref: '#/$defs/AMDCategory' } },
  required: ['category'],
  title: 'AMDResponse',
  type: 'object',
};

const AMD_IVR_MENU_RESPONSE_SCHEMA = {
  $defs: {
    IVRMenuOption: {
      properties: {
        label: { title: 'Label', type: 'string' },
        dtmf: { default: '', title: 'Dtmf', type: 'string' },
        spoken_response: { default: '', title: 'Spoken Response', type: 'string' },
      },
      required: ['label'],
      title: 'IVRMenuOption',
      type: 'object',
    },
  },
  properties: {
    menu: { title: 'Menu', type: 'string' },
    options: {
      items: { $ref: '#/$defs/IVRMenuOption' },
      maxItems: 20,
      title: 'Options',
      type: 'array',
    },
  },
  required: ['menu'],
  title: 'AMDIVRMenuResponse',
  type: 'object',
};

interface ChatCall {
  chatCtx: ChatContext;
  toolCtx: ToolContextLike | undefined;
  toolChoice: ToolChoice | undefined;
  parallelToolCalls: boolean | undefined;
}

/** Answers every request with the scripted tool calls and records the call options. */
class ScriptedLLM extends LLM {
  readonly calls: ChatCall[] = [];

  constructor(private readonly toolCalls: Array<{ name: string; args: string }>) {
    super();
  }

  label(): string {
    return 'scripted-llm';
  }

  chat({
    chatCtx,
    toolCtx,
    connOptions = DEFAULT_API_CONNECT_OPTIONS,
    parallelToolCalls,
    toolChoice,
  }: {
    chatCtx: ChatContext;
    toolCtx?: ToolContextLike;
    connOptions?: APIConnectOptions;
    parallelToolCalls?: boolean;
    toolChoice?: ToolChoice;
    extraKwargs?: Record<string, unknown>;
  }): LLMStream {
    this.calls.push({ chatCtx, toolCtx, toolChoice, parallelToolCalls });
    return new ScriptedStream(this, { chatCtx, toolCtx, connOptions }, this.toolCalls);
  }
}

class ScriptedStream extends LLMStream {
  constructor(
    model: LLM,
    params: { chatCtx: ChatContext; toolCtx?: ToolContextLike; connOptions: APIConnectOptions },
    private readonly toolCalls: Array<{ name: string; args: string }>,
  ) {
    super(model, {
      chatCtx: params.chatCtx,
      toolCtx: params.toolCtx as never,
      connOptions: { ...params.connOptions, maxRetry: 0 },
    });
  }

  protected async run(): Promise<void> {
    if (this.toolCalls.length === 0) {
      return;
    }
    this.queue.put({
      id: 'scripted',
      delta: {
        role: 'assistant',
        toolCalls: this.toolCalls.map(({ name, args }, i) =>
          FunctionCall.create({ name, args, callId: String(i) }),
        ),
      },
    });
  }
}

const CHAT_CTX = new ChatContext();
CHAT_CTX.addMessage({ role: 'user', content: 'input' });
const REQUEST: AMDRequest = {
  stage: AMDCategory.UNCERTAIN,
  recommendedNextCategories: Object.values(AMDCategory).sort(),
  previousPrediction: null,
  chatCtx: CHAT_CTX,
  speechDuration: 500,
};

function onlyTool(call: ChatCall): FunctionTool {
  const tools = toToolContext(call.toolCtx!).flatten();
  expect(tools).toHaveLength(1);
  return tools[0] as FunctionTool;
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

describe('AMD inference', () => {
  it('keeps the classifier and menu prompts byte-identical to Python', () => {
    expect(CLASSIFY_PROMPT).toHaveLength(5059);
    expect(sha256(CLASSIFY_PROMPT)).toBe(
      '9837ebd5610c7b34b833a2fbbfb07d192ce68a586c071ab8f69b1abdbf9c506f',
    );
    expect(MENU_PROMPT).toHaveLength(528);
    expect(sha256(MENU_PROMPT)).toBe(
      '390f49a72312813b215380309d4166c467afc7686280c2049cb580c715b016fa',
    );
  });

  it('writes the classifier constraints with Python json.dumps formatting', async () => {
    const model = new ScriptedLLM([{ name: 'record_result', args: '{"category":"human"}' }]);
    const previousPrediction = {
      type: 'amd_prediction' as const,
      speechDuration: 1_000,
      category: AMDCategory.MACHINE_VM,
      reason: 'prediction' as never,
      transcript: 'Leave a message.',
      delay: 100,
      turnId: 2,
      stage: AMDCategory.MACHINE_VM,
      inferenceDuration: 50,
    };
    await classify(model, {
      ...REQUEST,
      stage: AMDCategory.MACHINE_VM,
      recommendedNextCategories: fsm.recommendedNext(AMDCategory.MACHINE_VM),
      previousPrediction,
      speechDuration: 1_000,
    });
    const items = model.calls[0]!.chatCtx.items as ChatMessage[];
    expect(items[0]!.textContent).toBe(CLASSIFY_PROMPT);
    expect(items[1]!.textContent).toBe(
      '{"stage": "machine-vm", "previous_prediction": {"category": "machine-vm", ' +
        '"reason": "prediction", "turn_id": 2}, "recommended_next_categories": ' +
        '["human", "machine-ivr", "machine-unavailable", "machine-vm", "uncertain", "wait"], ' +
        '"speech_duration": 1.0}',
    );
    expect(items[2]!.textContent).toBe('input');
  });

  it.each(['not JSON', '[]', '{"category":"unknown"}', '```json\n{"category":"human"}\n```'])(
    'classifier rejects invalid tool arguments: %s',
    async (args) => {
      const model = new ScriptedLLM([{ name: 'record_result', args }]);
      await expect(classify(model, REQUEST)).rejects.toThrow(AMDResponseError);
    },
  );

  describe.each([false, true])('menu %s', (menu) => {
    it.each([false, true])(
      'amd uses a required structured tool (fallback %s)',
      async (fallback) => {
        const payload = menu
          ? { menu: 'Main menu', options: [{ label: 'Talk to a person', dtmf: '1' }] }
          : { category: 'human' };
        const model = new ScriptedLLM([{ name: 'record_result', args: JSON.stringify(payload) }]);
        const adapter = fallback ? new FallbackAdapter({ llms: [model] }) : model;
        try {
          let result: unknown;
          let schema: Record<string, unknown>;
          if (menu) {
            result = await extractIvrMenu(adapter, 'input');
            schema = AMD_IVR_MENU_RESPONSE_SCHEMA;
            expect(result).toEqual({
              menu: 'Main menu',
              options: [{ label: 'Talk to a person', dtmf: '1', spokenResponse: '' }],
            });
            const user = model.calls[0]!.chatCtx.items[1] as ChatMessage;
            expect(user.textContent).toBe('{"transcript": "input"}');
          } else {
            result = await classify(adapter, REQUEST);
            schema = AMD_RESPONSE_SCHEMA;
            expect(result).toEqual({ category: AMDCategory.HUMAN });
          }
          expect(model.calls).toHaveLength(1);
          const call = model.calls[0]!;
          expect(call.toolChoice).toBe('required');
          expect(call.parallelToolCalls).toBe(false);
          const tool = onlyTool(call);
          expect(tool.name).toBe('record_result');
          expect(tool.parameters).toEqual(schema);
          // providers receive the raw schema unchanged
          expect(toJsonSchema(tool.parameters as never, true)).toEqual(schema);
          expect(toJsonSchema(tool.parameters as never, false)).toEqual(schema);
        } finally {
          await adapter.aclose();
        }
      },
    );
  });

  it.each([[[]], [['unexpected']], [['record_result', 'record_result']]])(
    'classifier requires exactly one result tool: %j',
    async (names) => {
      const model = new ScriptedLLM(names.map((name) => ({ name, args: '{"category":"human"}' })));
      await expect(classify(model, REQUEST)).rejects.toThrow('exactly one record_result');
    },
  );

  describe.each([
    AMDCategory.UNCERTAIN,
    AMDCategory.MACHINE_SCREENING,
    AMDCategory.MACHINE_VM,
    AMDCategory.MACHINE_IVR,
  ])('stage %s', (stage) => {
    it.each(Object.values(AMDCategory))(
      'classifier recommends next states without restricting predictions: %s',
      async (category) => {
        const request: AMDRequest = {
          ...REQUEST,
          stage,
          recommendedNextCategories: fsm.recommendedNext(stage),
        };
        const model = new ScriptedLLM([
          { name: 'record_result', args: JSON.stringify({ category }) },
        ]);
        try {
          expect((await classify(model, request)).category).toBe(category);
          const call = model.calls[0]!;
          const schema = onlyTool(call).parameters as typeof AMD_RESPONSE_SCHEMA;
          expect(schema.$defs.AMDCategory.enum).toEqual(Object.values(AMDCategory));
          const constraints = JSON.parse((call.chatCtx.items[1] as ChatMessage).textContent!);
          expect(constraints.recommended_next_categories).toEqual(
            request.recommendedNextCategories,
          );
          for (const isOpenai of [true, false]) {
            expect(toJsonSchema(onlyTool(call).parameters as never, isOpenai)).toEqual(schema);
          }
        } finally {
          await model.aclose();
        }
      },
    );
  });
});
