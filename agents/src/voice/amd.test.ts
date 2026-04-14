// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { ChatContext } from '../llm/chat_context.js';
import type { ChatChunk } from '../llm/llm.js';
import { LLM, type LLMStream } from '../llm/llm.js';
import type { ToolChoice, ToolContext } from '../llm/tool_context.js';
import type { APIConnectOptions } from '../types.js';
import type { AgentSession } from './agent_session.js';
import { AMD, AMDCategory } from './amd.js';
import { AgentSessionEventTypes } from './events.js';

class StaticLLM extends LLM {
  constructor(private readonly response: string | Error) {
    super();
  }

  label(): string {
    return 'static-llm';
  }

  chat({
    chatCtx: _chatCtx,
    toolCtx: _toolCtx,
    connOptions: _connOptions,
  }: {
    chatCtx: ChatContext;
    toolCtx?: ToolContext;
    connOptions?: APIConnectOptions;
    parallelToolCalls?: boolean;
    toolChoice?: ToolChoice;
    extraKwargs?: Record<string, unknown>;
  }): LLMStream {
    const response = this.response;
    return {
      async *[Symbol.asyncIterator](): AsyncGenerator<ChatChunk> {
        if (response instanceof Error) {
          throw response;
        }

        yield {
          id: 'static',
          delta: { role: 'assistant', content: response },
        };
      },
    } as unknown as LLMStream;
  }
}

class MockSession extends EventEmitter {
  llm?: LLM;
  pauseReplyAuthorization = vi.fn();
  resumeReplyAuthorization = vi.fn();
  interrupt = vi.fn(() => ({ await: Promise.resolve() }));
}

const asAgentSession = (session: MockSession): AgentSession => session as unknown as AgentSession;

describe('AMD', () => {
  it('should classify voicemail and interrupt queued speech', async () => {
    const session = new MockSession();
    const llm = new StaticLLM(
      JSON.stringify({
        category: AMDCategory.MACHINE_VM,
        reason: 'The transcript is a voicemail greeting.',
      }),
    );
    llm.on('error', () => {});
    const amd = new AMD(asAgentSession(session), { llm, detectionTimeoutMs: 50 });

    const promise = amd.execute();
    session.emit(AgentSessionEventTypes.UserInputTranscribed, {
      type: 'user_input_transcribed',
      transcript: 'Please leave a message after the tone',
      isFinal: true,
      speakerId: null,
      createdAt: Date.now(),
      language: null,
    });

    await expect(promise).resolves.toMatchObject({
      category: AMDCategory.MACHINE_VM,
      isMachine: true,
    });
    expect(session.pauseReplyAuthorization).toHaveBeenCalledTimes(1);
    expect(session.resumeReplyAuthorization).toHaveBeenCalled();
    expect(session.interrupt).toHaveBeenCalledWith({ force: true });
  });

  it('should classify unavailable mailbox as machine', async () => {
    const session = new MockSession();
    const llm = new StaticLLM(
      JSON.stringify({
        category: AMDCategory.MACHINE_UNAVAILABLE,
        reason: 'The mailbox is unavailable and cannot accept messages.',
      }),
    );
    llm.on('error', () => {});
    const amd = new AMD(asAgentSession(session), { llm, detectionTimeoutMs: 50 });

    const promise = amd.execute();
    session.emit(AgentSessionEventTypes.UserInputTranscribed, {
      type: 'user_input_transcribed',
      transcript: 'The mailbox you are trying to reach is unavailable',
      isFinal: true,
      speakerId: null,
      createdAt: Date.now(),
      language: null,
    });

    await expect(promise).resolves.toMatchObject({
      category: AMDCategory.MACHINE_UNAVAILABLE,
      isMachine: true,
    });
  });

  it('should resume authorization when detection fails', async () => {
    const session = new MockSession();
    const llm = new StaticLLM(new Error('boom'));
    llm.on('error', () => {});
    const amd = new AMD(asAgentSession(session), { llm });

    const promise = amd.execute();
    session.emit(AgentSessionEventTypes.UserInputTranscribed, {
      type: 'user_input_transcribed',
      transcript: 'Hello?',
      isFinal: true,
      speakerId: null,
      createdAt: Date.now(),
      language: null,
    });

    await expect(promise).rejects.toThrow('boom');
    expect(session.resumeReplyAuthorization).toHaveBeenCalled();
  });
});
