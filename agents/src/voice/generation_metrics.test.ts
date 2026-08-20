// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { ReadableStream } from 'node:stream/web';
import { describe, expect, it } from 'vitest';
import { ChatContext } from '../llm/chat_context.js';
import type { ChatChunk } from '../llm/llm.js';
import { ToolContext } from '../llm/tool_context.js';
import { isFlushSentinel } from '../types.js';
import {
  type _LLMGenerationData,
  type _TTSGenerationData,
  _timeToFirstSentence,
  performLLMInference,
} from './generation.js';
import type { LLMNode } from './io.js';

function content(text: string): ChatChunk {
  return { id: 'c', delta: { role: 'assistant', content: text } };
}

function usageChunk(completionTokens: number): ChatChunk {
  return {
    id: 'c',
    usage: {
      completionTokens,
      promptTokens: 5,
      promptCachedTokens: 0,
      totalTokens: completionTokens + 5,
    },
  };
}

async function runInference(
  chunks: ChatChunk[],
  delays: number[] = [],
): Promise<_LLMGenerationData> {
  const node: LLMNode = async () =>
    new ReadableStream<ChatChunk>({
      async start(controller) {
        for (let i = 0; i < chunks.length; i++) {
          const delay = delays[i] ?? 0;
          if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
          controller.enqueue(chunks[i]!);
        }
        controller.close();
      },
    });
  const [task, data] = performLLMInference(
    node,
    ChatContext.empty(),
    ToolContext.empty(),
    {},
    new AbortController(),
  );
  const textReader = data.textStream.getReader();
  const toolReader = data.toolCallStream.getReader();
  await Promise.all([
    task.result,
    (async () => {
      while (true) {
        const { done, value } = await textReader.read();
        if (done) break;
        if (typeof value !== 'string' && !isFlushSentinel(value)) {
          throw new Error('unexpected text output');
        }
      }
    })(),
    (async () => {
      while (!(await toolReader.read()).done) {}
    })(),
  ]);
  return data;
}

function ttsData(synthesisStartedAt?: number): _TTSGenerationData {
  return {
    audioStream: new ReadableStream(),
    timedTextsFut: {} as _TTSGenerationData['timedTextsFut'],
    synthesisStartedAt,
  };
}

describe('LLM node TPS', () => {
  it('is set when usage is reported', async () => {
    const data = await runInference(
      [content('Hello there, '), content('friend.'), usageChunk(30)],
      [0, 1],
    );
    expect(data.tps).toBeGreaterThan(0);
  });

  it('is zero when zero usage is reported', async () => {
    const data = await runInference(
      [content('Hello there, '), content('friend.'), usageChunk(0)],
      [0, 1],
    );
    expect(data.tps).toBe(0);
  });

  it('is absent when no usage is reported', async () => {
    expect((await runInference([content('Hello there, friend.')])).tps).toBeUndefined();
  });

  it('is absent when the reply arrived in one chunk', async () => {
    expect((await runInference([content('Sure!'), usageChunk(3)])).tps).toBeUndefined();
  });

  it('excludes time to first token', async () => {
    const data = await runInference(
      [content('Hello there, '), content('friend.'), usageChunk(10)],
      [200, 50],
    );
    expect(data.tps).toBeGreaterThan(100);
  });
});

describe('LLM node start time', () => {
  it('is recorded', async () => {
    expect((await runInference([content('Hello there, friend.')])).startedAt).toBeDefined();
  });
});

describe('time to first sentence', () => {
  it('is measured from LLM start to synthesis start', () => {
    const llmData = { startedAt: 100 } as _LLMGenerationData;
    expect(_timeToFirstSentence(llmData, ttsData(102.5))).toBeCloseTo(2.5);
  });

  it('is absent without TTS', () => {
    expect(_timeToFirstSentence({ startedAt: 100 } as _LLMGenerationData, null)).toBeUndefined();
  });

  it('is absent when TTS published no stamp', () => {
    expect(
      _timeToFirstSentence({ startedAt: 100 } as _LLMGenerationData, ttsData()),
    ).toBeUndefined();
  });

  it('is absent when LLM never started', () => {
    expect(_timeToFirstSentence({} as _LLMGenerationData, ttsData(102.5))).toBeUndefined();
  });
});
