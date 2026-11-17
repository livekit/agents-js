// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { ReadableStream } from 'node:stream/web';
import { describe, expect, it } from 'vitest';
import { APIError } from '../_exceptions.js';
import type { ChatContext } from '../llm/chat_context.js';
import { type ChatChunk, LLM, LLMStream } from '../llm/llm.js';
import { initializeLogger } from '../log.js';
import { type APIConnectOptions, DEFAULT_API_CONNECT_OPTIONS } from '../types.js';
import { Agent } from './agent.js';
import { AgentSession } from './agent_session.js';
import { AgentSessionEventTypes } from './events.js';
import type { SpeechHandle } from './speech_handle.js';
import { FakeLLM } from './testing/fake_llm.js';

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timed out')), ms)),
  ]);
}

class ErroringNodeAgent extends Agent {
  constructor(private readonly chunkFirst: boolean) {
    super({ instructions: 'test agent' });
  }

  override async llmNode(): Promise<ReadableStream<ChatChunk>> {
    const chunkFirst = this.chunkFirst;
    return new ReadableStream<ChatChunk>({
      start(controller) {
        if (chunkFirst) {
          controller.enqueue({ id: 'c', delta: { role: 'assistant', content: 'partial ' } });
        }
        setTimeout(() => controller.error(new Error('llm stream failed')), 10);
      },
    });
  }
}

describe('llm node stream that errors', () => {
  initializeLogger({ pretty: false, level: 'silent' });

  it.each([
    ['before the first chunk', false],
    ['after a chunk', true],
  ])('fails the reply instead of hanging it (%s)', async (_label, chunkFirst) => {
    const session = new AgentSession({ llm: new FakeLLM() });
    try {
      await session.start({ agent: new ErroringNodeAgent(chunkFirst) });
      // Without the fix the speech never finishes: the generation's finally block threw
      // from `llmStream.cancel()` before closing the text and tool-call writers.
      await expect(withTimeout(session.run({ userInput: 'hi' }).wait(), 3_000)).rejects.toThrow(
        'llm stream failed',
      );
    } finally {
      await session.close().catch(() => {});
    }
  });
});

/** An LLM whose provider request fails, as a plugin's does on a non-retryable API error. */
class FailingLLM extends LLM {
  label(): string {
    return 'failing-llm';
  }

  chat({
    chatCtx,
    connOptions = DEFAULT_API_CONNECT_OPTIONS,
  }: {
    chatCtx: ChatContext;
    connOptions?: APIConnectOptions;
  }): LLMStream {
    return new (class extends LLMStream {
      protected async run(): Promise<void> {
        throw new APIError('provider failed', { retryable: false });
      }
    })(this, { chatCtx, connOptions });
  }
}

describe('llm provider failure', () => {
  it('fails the reply with the provider error', async () => {
    const session = new AgentSession({ llm: new FailingLLM() });
    const handles: SpeechHandle[] = [];
    session.on(AgentSessionEventTypes.SpeechCreated, (ev) => handles.push(ev.speechHandle));
    try {
      await session.start({ agent: new Agent({ instructions: 'test agent' }) });
      // the failure must reach the run and the reply's handle, not only the error event
      await expect(withTimeout(session.run({ userInput: 'hi' }).wait(), 3_000)).rejects.toThrow(
        'provider failed',
      );
      expect(handles.at(-1)?.exception()).toBeInstanceOf(APIError);
    } finally {
      await session.close().catch(() => {});
    }
  });
});
