// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { ChatContext } from '../llm/chat_context.js';
import { FunctionCall } from '../llm/chat_context.js';
import type { ChatChunk } from '../llm/llm.js';
import { LLM, type LLMStream } from '../llm/llm.js';
import type { ToolChoice, ToolContext } from '../llm/tool_context.js';
import type { APIConnectOptions } from '../types.js';
import type { AgentSession } from './agent_session.js';
import { AMD, AMDCategory } from './amd.js';
import { AgentSessionEventTypes, type UserState } from './events.js';

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

class ToolCallLLM extends LLM {
  constructor(private readonly category: AMDCategory) {
    super();
  }

  label(): string {
    return 'tool-call-llm';
  }

  chat({}: {
    chatCtx: ChatContext;
    toolCtx?: ToolContext;
    connOptions?: APIConnectOptions;
    parallelToolCalls?: boolean;
    toolChoice?: ToolChoice;
    extraKwargs?: Record<string, unknown>;
  }): LLMStream {
    const category = this.category;
    return {
      async *[Symbol.asyncIterator](): AsyncGenerator<ChatChunk> {
        yield {
          id: 'tc',
          delta: {
            role: 'assistant',
            toolCalls: [
              new FunctionCall({
                callId: 'call_1',
                name: 'save_prediction',
                args: JSON.stringify({ label: category }),
              }),
            ],
          },
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

type AMDInternals = {
  silenceTimer: ReturnType<typeof setTimeout> | undefined;
  silenceTimerTrigger: 'short_speech' | 'long_speech' | undefined;
  machineSilenceReached: boolean;
  speechEndedAt: number | undefined;
};

const amdInternals = (amd: AMD): AMDInternals => amd as unknown as AMDInternals;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function emitUserStateChanged(
  session: MockSession,
  oldState: UserState,
  newState: UserState,
  createdAt: number = Date.now(),
) {
  session.emit(AgentSessionEventTypes.UserStateChanged, {
    type: 'user_state_changed',
    oldState,
    newState,
    createdAt,
  });
}

function emitFinalTranscript(
  session: MockSession,
  transcript: string,
  createdAt: number = Date.now(),
) {
  session.emit(AgentSessionEventTypes.UserInputTranscribed, {
    type: 'user_input_transcribed',
    transcript,
    isFinal: true,
    speakerId: null,
    createdAt,
    language: null,
  });
}

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

    const result = await promise;
    expect(result).toMatchObject({
      category: AMDCategory.MACHINE_VM,
      isMachine: true,
      speechDurationMs: 0,
      delayMs: 0,
    });
    expect(Object.is(result.delayMs, -0)).toBe(false);
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

  it('should settle the execute promise when aclose is called', async () => {
    const session = new MockSession();
    const llm = new StaticLLM(JSON.stringify({ category: AMDCategory.HUMAN, reason: 'test' }));
    llm.on('error', () => {});
    const amd = new AMD(asAgentSession(session), { llm });

    const promise = amd.execute();
    await amd.aclose();

    await expect(promise).rejects.toThrow('AMD closed');
    expect(session.resumeReplyAuthorization).toHaveBeenCalled();
  });

  it('should settle from a save_prediction tool call', async () => {
    const session = new MockSession();
    const llm = new ToolCallLLM(AMDCategory.MACHINE_IVR);
    llm.on('error', () => {});
    const amd = new AMD(asAgentSession(session), { llm, detectionTimeoutMs: 50 });

    const promise = amd.execute();
    session.emit(AgentSessionEventTypes.UserInputTranscribed, {
      type: 'user_input_transcribed',
      transcript: 'Press 1 for sales, 2 for support',
      isFinal: true,
      speakerId: null,
      createdAt: Date.now(),
      language: null,
    });

    await expect(promise).resolves.toMatchObject({
      category: AMDCategory.MACHINE_IVR,
      reason: 'llm',
      isMachine: true,
    });
    expect(session.interrupt).toHaveBeenCalledWith({ force: true });
  });

  it('should accept the new tunable parameters', async () => {
    const session = new MockSession();
    const llm = new StaticLLM(
      JSON.stringify({ category: AMDCategory.HUMAN, reason: 'live person' }),
    );
    llm.on('error', () => {});
    const amd = new AMD(asAgentSession(session), {
      llm,
      humanSpeechThresholdMs: 1_000,
      humanSilenceThresholdMs: 250,
      machineSilenceThresholdMs: 750,
      prompt: 'custom prompt',
      participantIdentity: 'caller-1',
      suppressCompatibilityWarning: true,
      detectionTimeoutMs: 50,
    });

    const promise = amd.execute();
    session.emit(AgentSessionEventTypes.UserInputTranscribed, {
      type: 'user_input_transcribed',
      transcript: 'Hello?',
      isFinal: true,
      speakerId: null,
      createdAt: Date.now(),
      language: null,
    });

    await expect(promise).resolves.toMatchObject({ category: AMDCategory.HUMAN });
  });

  it('short greeting no transcript emits pre-baked human', async () => {
    const session = new MockSession();
    const llm = new StaticLLM('');
    llm.on('error', () => {});
    const amd = new AMD(asAgentSession(session), {
      llm,
      humanSilenceThresholdMs: 100,
      noSpeechTimeoutMs: 5_000,
      detectionTimeoutMs: 5_000,
    });

    const promise = amd.execute();
    emitUserStateChanged(session, 'listening', 'speaking');
    await sleep(50);
    emitUserStateChanged(session, 'speaking', 'listening');
    expect(amdInternals(amd).silenceTimerTrigger).toBe('short_speech');
    expect(amdInternals(amd).silenceTimer).toBeDefined();

    const result = await promise;

    expect(result.category).toBe(AMDCategory.HUMAN);
    expect(result.reason).toBe('short_greeting');
    expect(amdInternals(amd).silenceTimer).toBeUndefined();
    expect(amdInternals(amd).silenceTimerTrigger).toBeUndefined();
    expect(amdInternals(amd).machineSilenceReached).toBe(true);
  });

  it('push text cancels pre-baked human and flips trigger', async () => {
    const session = new MockSession();
    const llm = new StaticLLM('');
    llm.on('error', () => {});
    const amd = new AMD(asAgentSession(session), {
      llm,
      humanSilenceThresholdMs: 100,
      machineSilenceThresholdMs: 300,
      noSpeechTimeoutMs: 5_000,
      detectionTimeoutMs: 5_000,
    });

    const promise = amd.execute();
    let settled = false;
    void promise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    emitUserStateChanged(session, 'listening', 'speaking');
    await sleep(50);
    emitUserStateChanged(session, 'speaking', 'listening');
    expect(amdInternals(amd).silenceTimerTrigger).toBe('short_speech');

    emitFinalTranscript(session, 'hello');
    expect(amdInternals(amd).silenceTimerTrigger).toBe('long_speech');
    expect(amdInternals(amd).silenceTimer).toBeDefined();

    await sleep(180);
    expect(settled).toBe(false);
    expect(amdInternals(amd).machineSilenceReached).toBe(false);

    await sleep(200);
    expect(amdInternals(amd).machineSilenceReached).toBe(true);
    expect(settled).toBe(false);

    await amd.aclose();
    await expect(promise).rejects.toThrow('AMD closed');
  });

  it('push text replacement timer preserves original deadline', async () => {
    const session = new MockSession();
    const llm = new StaticLLM('');
    llm.on('error', () => {});
    const amd = new AMD(asAgentSession(session), {
      llm,
      humanSilenceThresholdMs: 50,
      machineSilenceThresholdMs: 300,
      noSpeechTimeoutMs: 5_000,
      detectionTimeoutMs: 5_000,
    });

    const promise = amd.execute();
    emitUserStateChanged(session, 'listening', 'speaking');
    await sleep(50);
    emitUserStateChanged(session, 'speaking', 'listening');
    const speechEndedAt = amdInternals(amd).speechEndedAt;
    expect(speechEndedAt).toBeDefined();

    await sleep(40);
    emitFinalTranscript(session, 'hello');
    expect(amdInternals(amd).silenceTimerTrigger).toBe('long_speech');

    const deadline = speechEndedAt! + 600;
    while (!amdInternals(amd).machineSilenceReached && Date.now() < deadline) {
      await sleep(10);
    }

    const firedAt = Date.now();
    expect(amdInternals(amd).machineSilenceReached).toBe(true);
    expect(firedAt - speechEndedAt!).toBeLessThan(450);

    await amd.aclose();
    await expect(promise).rejects.toThrow('AMD closed');
  });

  it('long speech push text does not replace timer', async () => {
    const session = new MockSession();
    const llm = new StaticLLM('');
    llm.on('error', () => {});
    const amd = new AMD(asAgentSession(session), {
      llm,
      humanSpeechThresholdMs: 100,
      machineSilenceThresholdMs: 300,
      noSpeechTimeoutMs: 5_000,
      detectionTimeoutMs: 5_000,
    });

    const promise = amd.execute();
    emitUserStateChanged(session, 'listening', 'speaking');
    await sleep(150);
    emitUserStateChanged(session, 'speaking', 'listening');
    expect(amdInternals(amd).silenceTimerTrigger).toBe('long_speech');
    const handleBefore = amdInternals(amd).silenceTimer;
    expect(handleBefore).toBeDefined();

    emitFinalTranscript(session, 'hello world');
    expect(amdInternals(amd).silenceTimerTrigger).toBe('long_speech');
    expect(amdInternals(amd).silenceTimer).toBe(handleBefore);

    await amd.aclose();
    await expect(promise).rejects.toThrow('AMD closed');
  });

  it('short greeting with existing transcript uses long speech trigger', async () => {
    const session = new MockSession();
    const llm = new StaticLLM('');
    llm.on('error', () => {});
    const amd = new AMD(asAgentSession(session), {
      llm,
      humanSilenceThresholdMs: 100,
      machineSilenceThresholdMs: 300,
      noSpeechTimeoutMs: 5_000,
      detectionTimeoutMs: 5_000,
    });

    const promise = amd.execute();
    emitUserStateChanged(session, 'listening', 'speaking');
    await sleep(50);
    emitFinalTranscript(session, 'hi');
    emitUserStateChanged(session, 'speaking', 'listening');
    expect(amdInternals(amd).silenceTimerTrigger).toBe('long_speech');
    const handleBefore = amdInternals(amd).silenceTimer;
    expect(handleBefore).toBeDefined();

    emitFinalTranscript(session, 'there');
    expect(amdInternals(amd).silenceTimer).toBe(handleBefore);
    expect(amdInternals(amd).silenceTimerTrigger).toBe('long_speech');

    await amd.aclose();
    await expect(promise).rejects.toThrow('AMD closed');
  });

  it('user speech started clears trigger', async () => {
    const session = new MockSession();
    const llm = new StaticLLM('');
    llm.on('error', () => {});
    const amd = new AMD(asAgentSession(session), {
      llm,
      humanSilenceThresholdMs: 1_000,
      noSpeechTimeoutMs: 5_000,
      detectionTimeoutMs: 5_000,
    });

    const promise = amd.execute();
    emitUserStateChanged(session, 'listening', 'speaking');
    await sleep(50);
    emitUserStateChanged(session, 'speaking', 'listening');
    expect(amdInternals(amd).silenceTimer).toBeDefined();
    expect(amdInternals(amd).silenceTimerTrigger).toBe('short_speech');

    emitUserStateChanged(session, 'listening', 'speaking');
    expect(amdInternals(amd).silenceTimer).toBeUndefined();
    expect(amdInternals(amd).silenceTimerTrigger).toBeUndefined();

    await amd.aclose();
    await expect(promise).rejects.toThrow('AMD closed');
  });

  it('silence callback clears trigger on fire', async () => {
    const session = new MockSession();
    const llm = new StaticLLM('');
    llm.on('error', () => {});
    const amd = new AMD(asAgentSession(session), {
      llm,
      humanSilenceThresholdMs: 50,
      noSpeechTimeoutMs: 5_000,
      detectionTimeoutMs: 5_000,
    });

    const promise = amd.execute();
    emitUserStateChanged(session, 'listening', 'speaking');
    await sleep(20);
    emitUserStateChanged(session, 'speaking', 'listening');
    expect(amdInternals(amd).silenceTimerTrigger).toBe('short_speech');

    await expect(promise).resolves.toMatchObject({ category: AMDCategory.HUMAN });

    expect(amdInternals(amd).silenceTimer).toBeUndefined();
    expect(amdInternals(amd).silenceTimerTrigger).toBeUndefined();
  });

  it('short greeting transcript emits llm verdict', async () => {
    const session = new MockSession();
    const llm = new ToolCallLLM(AMDCategory.HUMAN);
    llm.on('error', () => {});
    const amd = new AMD(asAgentSession(session), {
      llm,
      humanSilenceThresholdMs: 100,
      machineSilenceThresholdMs: 300,
      noSpeechTimeoutMs: 5_000,
      detectionTimeoutMs: 5_000,
    });

    const promise = amd.execute();
    emitUserStateChanged(session, 'listening', 'speaking');
    await sleep(50);
    emitUserStateChanged(session, 'speaking', 'listening');
    emitFinalTranscript(session, 'hello');

    const result = await promise;
    expect(result.category).toBe(AMDCategory.HUMAN);
    expect(result.reason).toBe('llm');
    expect(result.transcript).toBe('hello');
  });

  it('returns positive zero delay when speech end is unavailable', async () => {
    const session = new MockSession();
    const llm = new StaticLLM('');
    llm.on('error', () => {});
    const amd = new AMD(asAgentSession(session), {
      llm,
      noSpeechTimeoutMs: 10,
      detectionTimeoutMs: 5_000,
    });

    const result = await amd.execute();

    expect(result).toMatchObject({
      category: AMDCategory.MACHINE_UNAVAILABLE,
      reason: 'no_speech_timeout',
      speechDurationMs: 0,
      delayMs: 0,
    });
    expect(Object.is(result.delayMs, -0)).toBe(false);
  });
});
