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
import type { SpeechEvent, SpeechStream } from '../stt/stt.js';
import { STT } from '../stt/stt.js';
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
    const amd = new AMD(asAgentSession(session), { llm, stt: null, detectionTimeoutMs: 50 });

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
    const amd = new AMD(asAgentSession(session), { llm, stt: null, detectionTimeoutMs: 50 });

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
    const amd = new AMD(asAgentSession(session), { llm, stt: null });

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
    const amd = new AMD(asAgentSession(session), { llm, stt: null });

    const promise = amd.execute();
    await amd.aclose();

    await expect(promise).rejects.toThrow('AMD closed');
    expect(session.resumeReplyAuthorization).toHaveBeenCalled();
  });

  it('should settle from a save_prediction tool call', async () => {
    class ToolCallLLM extends LLM {
      label(): string {
        return 'tool-call-llm';
      }
      chat({}: {
        chatCtx: ChatContext;
        toolCtx?: ToolContext;
        connOptions?: APIConnectOptions;
      }): LLMStream {
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
                    args: JSON.stringify({ label: AMDCategory.MACHINE_IVR }),
                  }),
                ],
              },
            };
          },
        } as unknown as LLMStream;
      }
    }

    const session = new MockSession();
    const llm = new ToolCallLLM();
    llm.on('error', () => {});
    const amd = new AMD(asAgentSession(session), { llm, stt: null, detectionTimeoutMs: 50 });

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
      stt: null,
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

  it('should not fire short_greeting when a transcript arrives late', async () => {
    const session = new MockSession();
    const llm = new StaticLLM(
      JSON.stringify({ category: AMDCategory.HUMAN, reason: 'llm-verified' }),
    );
    llm.on('error', () => {});
    const amd = new AMD(asAgentSession(session), {
      llm,
      stt: null,
      humanSilenceThresholdMs: 100,
      machineSilenceThresholdMs: 300,
      detectionTimeoutMs: 5_000,
      suppressCompatibilityWarning: true,
    });

    const promise = amd.execute();
    const t0 = Date.now();

    session.emit(AgentSessionEventTypes.UserStateChanged, {
      type: 'user_state_changed',
      oldState: 'listening',
      newState: 'speaking',
      createdAt: t0,
    });
    session.emit(AgentSessionEventTypes.UserStateChanged, {
      type: 'user_state_changed',
      oldState: 'speaking',
      newState: 'listening',
      createdAt: t0 + 50,
    });

    // Transcript arrives 40ms after speech end, well inside the 100ms HUMAN
    // silence window. Without the fix this would race the short_greeting timer.
    await new Promise((resolve) => setTimeout(resolve, 40));
    session.emit(AgentSessionEventTypes.UserInputTranscribed, {
      type: 'user_input_transcribed',
      transcript: 'hello there',
      isFinal: true,
      speakerId: null,
      createdAt: Date.now(),
      language: null,
    });

    const result = await promise;
    expect(result.category).toBe(AMDCategory.HUMAN);
    expect(result.reason).toBe('llm-verified');
    expect(result.transcript).toBe('hello there');
  }, 5_000);

  it('should still fire short_greeting when no transcript arrives', async () => {
    const session = new MockSession();
    const llm = new StaticLLM(JSON.stringify({ category: AMDCategory.HUMAN, reason: 'unused' }));
    llm.on('error', () => {});
    const amd = new AMD(asAgentSession(session), {
      llm,
      stt: null,
      humanSilenceThresholdMs: 100,
      machineSilenceThresholdMs: 300,
      detectionTimeoutMs: 5_000,
      suppressCompatibilityWarning: true,
    });

    const promise = amd.execute();
    const t0 = Date.now();

    session.emit(AgentSessionEventTypes.UserStateChanged, {
      type: 'user_state_changed',
      oldState: 'listening',
      newState: 'speaking',
      createdAt: t0,
    });
    session.emit(AgentSessionEventTypes.UserStateChanged, {
      type: 'user_state_changed',
      oldState: 'speaking',
      newState: 'listening',
      createdAt: t0 + 50,
    });

    const result = await promise;
    expect(result.category).toBe(AMDCategory.HUMAN);
    expect(result.reason).toBe('short_greeting');
  }, 5_000);

  it('should expose speechDurationMs and delayMs in the result', async () => {
    const session = new MockSession();
    const llm = new StaticLLM(JSON.stringify({ category: AMDCategory.HUMAN, reason: 'live' }));
    llm.on('error', () => {});
    const amd = new AMD(asAgentSession(session), {
      llm,
      stt: null,
      humanSilenceThresholdMs: 50,
      machineSilenceThresholdMs: 200,
      detectionTimeoutMs: 5_000,
      suppressCompatibilityWarning: true,
    });

    const promise = amd.execute();
    const t0 = Date.now();

    session.emit(AgentSessionEventTypes.UserStateChanged, {
      type: 'user_state_changed',
      oldState: 'listening',
      newState: 'speaking',
      createdAt: t0,
    });
    session.emit(AgentSessionEventTypes.UserStateChanged, {
      type: 'user_state_changed',
      oldState: 'speaking',
      newState: 'listening',
      createdAt: t0 + 80,
    });

    const result = await promise;
    expect(result.speechDurationMs).toBeGreaterThanOrEqual(80);
    expect(result.delayMs).toBeGreaterThanOrEqual(0);
  }, 5_000);

  it('should register and clear session._amd via _setAmd', async () => {
    const setAmd = vi.fn();
    const session = Object.assign(new MockSession(), { _setAmd: setAmd });
    const llm = new StaticLLM(JSON.stringify({ category: AMDCategory.HUMAN, reason: 'live' }));
    llm.on('error', () => {});

    const amd = new AMD(asAgentSession(session), { llm, stt: null });
    expect(setAmd).toHaveBeenCalledWith(amd);

    setAmd.mockClear();
    await amd.aclose();
    expect(setAmd).toHaveBeenCalledWith(null);
  });

  it('should fall back to session.llm when llm is null', async () => {
    const session = new MockSession();
    const llm = new StaticLLM(JSON.stringify({ category: AMDCategory.HUMAN, reason: 'session' }));
    llm.on('error', () => {});
    session.llm = llm;
    const amd = new AMD(asAgentSession(session), { llm: null, stt: null, detectionTimeoutMs: 50 });

    const promise = amd.execute();
    session.emit(AgentSessionEventTypes.UserInputTranscribed, {
      type: 'user_input_transcribed',
      transcript: 'Hello?',
      isFinal: true,
      speakerId: null,
      createdAt: Date.now(),
      language: null,
    });
    await expect(promise).resolves.toMatchObject({
      category: AMDCategory.HUMAN,
      reason: expect.any(String),
    });
  });

  it('should throw when llm is null and session has no compatible LLM', () => {
    const session = new MockSession();
    expect(() => new AMD(asAgentSession(session), { llm: null, stt: null })).toThrow(/llm: null/);
  });

  it('should not close caller-owned LLM in aclose()', async () => {
    const session = new MockSession();
    const llm = new StaticLLM(JSON.stringify({ category: AMDCategory.HUMAN, reason: 'unused' }));
    llm.on('error', () => {});
    const acloseSpy = vi.spyOn(llm, 'aclose');
    const amd = new AMD(asAgentSession(session), { llm, stt: null });
    await amd.aclose();
    expect(acloseSpy).not.toHaveBeenCalled();
  });

  it('should consume transcripts from a dedicated STT pump (source = amd_stt)', async () => {
    // Mock STT whose stream yields one FINAL_TRANSCRIPT event then completes.
    class FakeSpeechStream implements AsyncIterableIterator<SpeechEvent> {
      private events: SpeechEvent[] = [];
      private resolved = false;
      pushFrame(): void {}
      flush(): void {}
      endInput(): void {}
      close(): void {}
      pushEvent(ev: SpeechEvent): void {
        this.events.push(ev);
      }
      async next(): Promise<IteratorResult<SpeechEvent>> {
        if (this.events.length > 0) {
          return { done: false, value: this.events.shift()! };
        }
        if (this.resolved) {
          return { done: true, value: undefined as unknown as SpeechEvent };
        }
        // Yield control briefly so the test can push more events.
        await new Promise((r) => setTimeout(r, 5));
        if (this.events.length > 0) {
          return { done: false, value: this.events.shift()! };
        }
        this.resolved = true;
        return { done: true, value: undefined as unknown as SpeechEvent };
      }
      [Symbol.asyncIterator](): this {
        return this;
      }
    }

    class FakeSTT extends STT {
      label = 'fake-stt';
      streamInstance = new FakeSpeechStream();
      constructor() {
        super({ streaming: true, interimResults: false });
      }
      protected _recognize(): Promise<SpeechEvent> {
        throw new Error('unused');
      }
      override stream(): SpeechStream {
        return this.streamInstance as unknown as SpeechStream;
      }
    }

    const session = new MockSession() as MockSession & {
      _subscribeAudioStream?: () => undefined;
    };
    // Provide an undefined audio source — the pump will poll, and we'll feed
    // FINAL_TRANSCRIPTs through the fake stream directly without needing audio
    // frames. The poll loop exits when settled.
    session._subscribeAudioStream = () => undefined;

    const llm = new StaticLLM(
      JSON.stringify({ category: AMDCategory.MACHINE_VM, reason: 'voicemail' }),
    );
    llm.on('error', () => {});
    const stt = new FakeSTT();
    const amd = new AMD(asAgentSession(session), {
      llm,
      stt,
      detectionTimeoutMs: 200,
      suppressCompatibilityWarning: true,
    });

    // Drive the AMD via a session-STT event — should be IGNORED because the
    // dedicated STT pump owns transcript ingestion (source filtering).
    const promise = amd.execute();
    session.emit(AgentSessionEventTypes.UserInputTranscribed, {
      type: 'user_input_transcribed',
      transcript: 'this should be ignored',
      isFinal: true,
      speakerId: null,
      createdAt: Date.now(),
      language: null,
    });

    // Detection timer fires while the dedicated STT pump never produced a
    // transcript → settles UNCERTAIN with no LLM verdict (the session event
    // was dropped).
    const result = await promise;
    expect(result.reason).toBe('detection_timeout');
    expect(result.category).toBe(AMDCategory.UNCERTAIN);
  }, 5_000);

  it('should extend silence window via postpone_termination', async () => {
    // LLM that calls postpone_termination once, then save_prediction(MACHINE_IVR).
    let callCount = 0;
    class PostponeLLM extends LLM {
      label(): string {
        return 'postpone-llm';
      }
      chat({}: { chatCtx: ChatContext; toolCtx?: ToolContext }): LLMStream {
        callCount += 1;
        const isFirst = callCount === 1;
        return {
          async *[Symbol.asyncIterator](): AsyncGenerator<ChatChunk> {
            yield {
              id: `tc-${callCount}`,
              delta: {
                role: 'assistant',
                toolCalls: [
                  isFirst
                    ? new FunctionCall({
                        callId: 'p1',
                        name: 'postpone_termination',
                        args: JSON.stringify({ seconds: 0.05 }),
                      })
                    : new FunctionCall({
                        callId: 's1',
                        name: 'save_prediction',
                        args: JSON.stringify({ label: AMDCategory.MACHINE_IVR }),
                      }),
                ],
              },
            };
          },
        } as unknown as LLMStream;
      }
    }

    const session = new MockSession();
    const llm = new PostponeLLM();
    llm.on('error', () => {});
    const amd = new AMD(asAgentSession(session), {
      llm,
      stt: null,
      detectionTimeoutMs: 5_000,
      suppressCompatibilityWarning: true,
    });

    const promise = amd.execute();
    session.emit(AgentSessionEventTypes.UserInputTranscribed, {
      type: 'user_input_transcribed',
      transcript: 'Press 1 for sales',
      isFinal: true,
      speakerId: null,
      createdAt: Date.now(),
      language: null,
    });

    const result = await promise;
    expect(result.category).toBe(AMDCategory.MACHINE_IVR);
    expect(callCount).toBeGreaterThanOrEqual(2);
  }, 5_000);
});
