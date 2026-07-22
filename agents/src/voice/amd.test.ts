// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatContext } from '../llm/chat_context.js';
import { FunctionCall } from '../llm/chat_context.js';
import type { ChatChunk } from '../llm/llm.js';
import { LLM, type LLMStream } from '../llm/llm.js';
import type { ToolChoice, ToolContextLike } from '../llm/tool_context.js';
import type { SpeechEvent, SpeechStream } from '../stt/stt.js';
import { STT } from '../stt/stt.js';
import type { APIConnectOptions } from '../types.js';
import type { AgentSession } from './agent_session.js';
import { AMD, AMDCategory } from './amd.js';
import type { EndOfTurnInfo } from './audio_recognition.js';

// AMD receives speech boundaries and transcripts via the recognition hooks that
// AgentActivity invokes (mirroring python AudioRecognition driving _AMDClassifier).
// Tests drive those hooks directly instead of emitting session events.
const speechStart = (amd: AMD): void => amd.onUserSpeechStarted();
const speechEnd = (amd: AMD, silenceDurationMs = 0): void =>
  amd.onUserSpeechEnded(silenceDurationMs);
const pushTranscript = (amd: AMD, text: string, source: 'stt' | 'amd_stt' = 'stt'): void =>
  amd.onTranscript(text, source);
const waitForListening = async (amd: AMD): Promise<void> => {
  const internals = amd as unknown as { listening?: boolean };
  for (let i = 0; i < 20; i += 1) {
    if (internals.listening) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  internals.listening = true;
};

const makeEotInfo = (newTranscript: string): EndOfTurnInfo => ({
  newTranscript,
  transcriptConfidence: 1,
  transcriptionDelay: 0,
  endOfUtteranceDelay: 0,
  startedSpeakingAt: undefined,
  stoppedSpeakingAt: undefined,
});

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
    toolCtx?: ToolContextLike;
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
  beforeEach(() => {
    vi.stubEnv('LIVEKIT_URL', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('should classify voicemail and interrupt queued speech', async () => {
    const session = new MockSession();
    const llm = new StaticLLM(
      JSON.stringify({
        category: AMDCategory.MACHINE_VM,
        reason: 'The transcript is a voicemail greeting.',
      }),
    );
    llm.on('error', () => {});
    const amd = new AMD(asAgentSession(session), {
      llm,
      detectionTimeoutMs: 5_000,
      machineSilenceThresholdMs: 20,
      maxEndpointingDelayMs: 20,
    });
    const onPrediction = vi.fn();
    amd.on('amd_prediction', onPrediction);

    const promise = amd.execute();
    await waitForListening(amd);
    speechStart(amd);
    pushTranscript(amd, 'Please leave a message after the tone');
    speechEnd(amd, 0);

    await expect(promise).resolves.toMatchObject({
      type: 'amd_prediction',
      category: AMDCategory.MACHINE_VM,
      isMachine: true,
    });
    expect(session.pauseReplyAuthorization).toHaveBeenCalledTimes(1);
    expect(session.resumeReplyAuthorization).toHaveBeenCalled();
    expect(session.interrupt).toHaveBeenCalledWith({ force: true });
    expect(onPrediction).toHaveBeenCalledTimes(1);
    expect(onPrediction.mock.calls[0]![0]).toMatchObject({
      type: 'amd_prediction',
      category: AMDCategory.MACHINE_VM,
    });
  });

  it('onEndOfTurn signals skip-reply after a machine verdict', async () => {
    const session = new MockSession();
    const llm = new StaticLLM(
      JSON.stringify({ category: AMDCategory.MACHINE_VM, reason: 'voicemail greeting' }),
    );
    llm.on('error', () => {});
    const amd = new AMD(asAgentSession(session), {
      llm,
      detectionTimeoutMs: 5_000,
      machineSilenceThresholdMs: 20,
      maxEndpointingDelayMs: 20,
    });

    const promise = amd.execute();
    await waitForListening(amd);
    speechStart(amd);
    pushTranscript(amd, 'Please leave a message after the tone');
    speechEnd(amd, 0);
    await promise;

    // machine verdict + interruptOnMachine (default) → skip the racing auto-reply
    expect(amd.onEndOfTurn(makeEotInfo('Please leave a message after the tone'))).toBe(true);
  });

  it('onEndOfTurn does not skip-reply for a human verdict', async () => {
    const session = new MockSession();
    const llm = new StaticLLM(
      JSON.stringify({ category: AMDCategory.HUMAN, reason: 'live person' }),
    );
    llm.on('error', () => {});
    const amd = new AMD(asAgentSession(session), { llm, detectionTimeoutMs: 50 });

    const promise = amd.execute();
    pushTranscript(amd, 'hello there');
    await promise;

    expect(amd.onEndOfTurn(makeEotInfo('hello there'))).toBe(false);
  });

  it('onEndOfTurn does not skip-reply when interruptOnMachine is false', async () => {
    const session = new MockSession();
    const llm = new StaticLLM(
      JSON.stringify({ category: AMDCategory.MACHINE_VM, reason: 'voicemail greeting' }),
    );
    llm.on('error', () => {});
    const amd = new AMD(asAgentSession(session), {
      llm,
      detectionTimeoutMs: 50,
      interruptOnMachine: false,
    });

    const promise = amd.execute();
    pushTranscript(amd, 'Please leave a message after the tone');
    await promise;

    // caller opted out of AMD taking over the turn, so the normal reply is not skipped
    expect(amd.onEndOfTurn(makeEotInfo('Please leave a message after the tone'))).toBe(false);
  });

  it('onEndOfTurn does not skip-reply while a machine verdict is committed but not yet emitted', async () => {
    const session = new MockSession();
    const llm = new StaticLLM(
      JSON.stringify({ category: AMDCategory.MACHINE_VM, reason: 'voicemail greeting' }),
    );
    llm.on('error', () => {});
    const amd = new AMD(asAgentSession(session), {
      llm,
      // keep the post-speech silence gate closed long enough to call onEndOfTurn
      // while the machine verdict is committed but still gated (not emitted).
      machineSilenceThresholdMs: 1_000,
      maxEndpointingDelayMs: 5_000,
      detectionTimeoutMs: 5_000,
      suppressCompatibilityWarning: true,
    });

    const promise = amd.execute();
    await waitForListening(amd);
    speechStart(amd);
    pushTranscript(amd, 'Please leave a message after the tone');
    speechEnd(amd, 0);

    // Let the LLM commit a machine verdict; the silence gate (1s) is still closed.
    await new Promise((r) => setTimeout(r, 50));

    // EOT arrives before post-speech silence: the verdict is committed but has not
    // cleared the emission gates, so we must NOT skip the reply yet — mirrors python
    // gating on the *emitted* `_result`, not the pre-emission committed verdict.
    expect(amd.onEndOfTurn(makeEotInfo('Please leave a message after the tone'))).toBe(false);

    // Once the silence gate opens the verdict emits, and a later EOT does skip.
    const result = await promise;
    expect(result.category).toBe(AMDCategory.MACHINE_VM);
    expect(amd.onEndOfTurn(makeEotInfo('Please leave a message after the tone'))).toBe(true);
  }, 5_000);

  it('should forward predictions to session._onAmdPrediction', async () => {
    const onAmdPrediction = vi.fn();
    const session = Object.assign(new MockSession(), { _onAmdPrediction: onAmdPrediction });
    const llm = new StaticLLM(
      JSON.stringify({ category: AMDCategory.HUMAN, reason: 'live person' }),
    );
    llm.on('error', () => {});
    const amd = new AMD(asAgentSession(session), {
      llm,
      detectionTimeoutMs: 5_000,
      machineSilenceThresholdMs: 20,
    });

    const promise = amd.execute();
    await waitForListening(amd);
    speechStart(amd);
    pushTranscript(amd, 'hello there');
    speechEnd(amd, 0);

    await promise;
    expect(onAmdPrediction).toHaveBeenCalledTimes(1);
    expect(onAmdPrediction.mock.calls[0]![0]).toMatchObject({
      type: 'amd_prediction',
      category: AMDCategory.HUMAN,
    });
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
    const amd = new AMD(asAgentSession(session), {
      llm,
      detectionTimeoutMs: 5_000,
      machineSilenceThresholdMs: 20,
      maxEndpointingDelayMs: 20,
    });

    const promise = amd.execute();
    await waitForListening(amd);
    speechStart(amd);
    pushTranscript(amd, 'The mailbox you are trying to reach is unavailable');
    speechEnd(amd, 0);

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
    await waitForListening(amd);
    speechStart(amd);
    pushTranscript(amd, 'Hello?');

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
    class ToolCallLLM extends LLM {
      label(): string {
        return 'tool-call-llm';
      }
      chat({}: {
        chatCtx: ChatContext;
        toolCtx?: ToolContextLike;
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
    const amd = new AMD(asAgentSession(session), {
      llm,
      detectionTimeoutMs: 5_000,
      machineSilenceThresholdMs: 20,
      maxEndpointingDelayMs: 20,
    });

    const promise = amd.execute();
    await waitForListening(amd);
    speechStart(amd);
    pushTranscript(amd, 'Press 1 for sales, 2 for support');
    speechEnd(amd, 0);

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
      detectionTimeoutMs: 5_000,
      maxEndpointingDelayMs: 20,
    });

    const promise = amd.execute();
    await waitForListening(amd);
    speechStart(amd);
    pushTranscript(amd, 'Hello?');
    speechEnd(amd, 0);

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
      humanSilenceThresholdMs: 100,
      machineSilenceThresholdMs: 300,
      detectionTimeoutMs: 5_000,
      suppressCompatibilityWarning: true,
    });

    const promise = amd.execute();
    await waitForListening(amd);
    speechStart(amd);
    speechEnd(amd, 0);

    // Transcript arrives 40ms after speech end, well inside the 100ms HUMAN
    // silence window. Without the fix this would race the short_greeting timer.
    await new Promise((resolve) => setTimeout(resolve, 40));
    pushTranscript(amd, 'hello there');

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
      humanSilenceThresholdMs: 100,
      machineSilenceThresholdMs: 300,
      detectionTimeoutMs: 5_000,
      suppressCompatibilityWarning: true,
    });

    const promise = amd.execute();
    speechStart(amd);
    speechEnd(amd, 0);

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
      humanSilenceThresholdMs: 50,
      machineSilenceThresholdMs: 200,
      detectionTimeoutMs: 5_000,
      suppressCompatibilityWarning: true,
    });

    const promise = amd.execute();
    speechStart(amd);
    // ~80ms of speech before it ends, so speechDuration reflects it
    await new Promise((resolve) => setTimeout(resolve, 80));
    speechEnd(amd, 0);

    const result = await promise;
    // setTimeout can fire a hair early, so allow scheduling slack below the 80ms
    // sleep; the point is that the duration reflects the speech window, not 0.
    expect(result.speechDurationMs).toBeGreaterThanOrEqual(70);
    expect(result.delayMs).toBeGreaterThanOrEqual(0);
  }, 5_000);

  it('should register and clear session._amd via _setAmd', async () => {
    const setAmd = vi.fn();
    const session = Object.assign(new MockSession(), { _setAmd: setAmd });
    const llm = new StaticLLM(JSON.stringify({ category: AMDCategory.HUMAN, reason: 'live' }));
    llm.on('error', () => {});

    const amd = new AMD(asAgentSession(session), { llm });
    expect(setAmd).toHaveBeenCalledWith(amd);

    setAmd.mockClear();
    await amd.aclose();
    expect(setAmd).toHaveBeenCalledWith(null);
  });

  it('should fall back to session.llm when no cloud creds are available', async () => {
    vi.stubEnv('LIVEKIT_URL', '');
    try {
      const session = new MockSession();
      const llm = new StaticLLM(JSON.stringify({ category: AMDCategory.HUMAN, reason: 'session' }));
      llm.on('error', () => {});
      session.llm = llm;
      const amd = new AMD(asAgentSession(session), { detectionTimeoutMs: 50 });

      const promise = amd.execute();
      pushTranscript(amd, 'Hello?');
      await expect(promise).resolves.toMatchObject({
        category: AMDCategory.HUMAN,
        reason: expect.any(String),
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('should throw when no cloud creds and session has no compatible LLM', () => {
    vi.stubEnv('LIVEKIT_URL', '');
    try {
      const session = new MockSession();
      expect(() => new AMD(asAgentSession(session))).toThrow(/no LLM available/);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('should not close caller-owned LLM in aclose()', async () => {
    const session = new MockSession();
    const llm = new StaticLLM(JSON.stringify({ category: AMDCategory.HUMAN, reason: 'unused' }));
    llm.on('error', () => {});
    const acloseSpy = vi.spyOn(llm, 'aclose');
    const amd = new AMD(asAgentSession(session), { llm });
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

    // A session-STT transcript (source 'stt') must be IGNORED because the
    // dedicated STT pump owns transcript ingestion (source = 'amd_stt').
    const promise = amd.execute();
    pushTranscript(amd, 'this should be ignored', 'stt');

    // Detection timer fires while the dedicated STT pump never produced a
    // transcript → settles UNCERTAIN with no LLM verdict (the 'stt' event
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
      chat({}: { chatCtx: ChatContext; toolCtx?: ToolContextLike }): LLMStream {
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
      detectionTimeoutMs: 5_000,
      // small end-of-turn backstop so the machine verdict's eot gate opens
      // quickly without a session turn detector (mirrors python on_user_speech_ended)
      maxEndpointingDelayMs: 100,
      suppressCompatibilityWarning: true,
    });

    const promise = amd.execute();
    await waitForListening(amd);
    // speech boundary so the eot backstop is armed, then the IVR transcript
    speechStart(amd);
    speechEnd(amd, 0);
    pushTranscript(amd, 'Press 1 for sales');

    const result = await promise;
    expect(result.category).toBe(AMDCategory.MACHINE_IVR);
    expect(callCount).toBeGreaterThanOrEqual(2);
  }, 5_000);

  it('no_speech_timeout settles as UNCERTAIN (not a machine)', async () => {
    const session = new MockSession();
    // session.llm fallback is unused because no transcript ever arrives
    session.llm = new StaticLLM(JSON.stringify({ category: AMDCategory.HUMAN, reason: 'x' }));
    const amd = new AMD(asAgentSession(session), {
      llm: session.llm,
      noSpeechTimeoutMs: 30,
      detectionTimeoutMs: 5_000,
      suppressCompatibilityWarning: true,
    });

    // No speech at all → no-speech timer fires.
    const result = await amd.execute();
    expect(result.reason).toBe('no_speech_timeout');
    expect(result.category).toBe(AMDCategory.UNCERTAIN);
    expect(result.isMachine).toBe(false);
    // not a machine → no forced interrupt
    expect(session.interrupt).not.toHaveBeenCalled();
  });

  it('waitUntilFinished defaults to gating a machine verdict on end-of-turn', async () => {
    const session = new MockSession();
    const llm = new StaticLLM(
      JSON.stringify({ category: AMDCategory.MACHINE_VM, reason: 'voicemail greeting' }),
    );
    llm.on('error', () => {});
    const amd = new AMD(asAgentSession(session), {
      llm,
      // long backstop so the only fast path to eot is the explicit turn-detector signal
      maxEndpointingDelayMs: 5_000,
      detectionTimeoutMs: 5_000,
      machineSilenceThresholdMs: 20,
      suppressCompatibilityWarning: true,
    });

    const promise = amd.execute();
    await waitForListening(amd);
    // transcript present before speech ends → machine-silence (not short-greeting) path
    speechStart(amd);
    pushTranscript(amd, 'Please leave a message after the tone');
    speechEnd(amd, 0);

    // Give silence + LLM verdict time to settle; the verdict must NOT emit yet
    // because the end-of-turn gate is still closed under waitUntilFinished.
    await new Promise((r) => setTimeout(r, 100));
    let settled = false;
    void promise.then(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(settled).toBe(false);

    // Turn detector commits end-of-turn → verdict releases.
    expect(amd.onEndOfTurn(makeEotInfo('Please leave a message after the tone'))).toBe(true);
    const result = await promise;
    expect(result.category).toBe(AMDCategory.MACHINE_VM);
  }, 5_000);

  it('waitUntilFinished can be disabled', async () => {
    const session = new MockSession();
    const llm = new StaticLLM(
      JSON.stringify({ category: AMDCategory.MACHINE_VM, reason: 'voicemail greeting' }),
    );
    llm.on('error', () => {});
    const amd = new AMD(asAgentSession(session), {
      llm,
      waitUntilFinished: false,
      maxEndpointingDelayMs: 5_000,
      detectionTimeoutMs: 50,
      suppressCompatibilityWarning: true,
    });

    const promise = amd.execute();
    await waitForListening(amd);
    speechStart(amd);
    pushTranscript(amd, 'Please leave a message after the tone');

    await expect(promise).resolves.toMatchObject({ category: AMDCategory.MACHINE_VM });
  }, 5_000);

  it('uses maxEndpointingDelay for transcripts without speech end', async () => {
    const session = new MockSession();
    const llm = new StaticLLM(
      JSON.stringify({ category: AMDCategory.MACHINE_VM, reason: 'voicemail greeting' }),
    );
    llm.on('error', () => {});
    const amd = new AMD(asAgentSession(session), {
      llm,
      maxEndpointingDelayMs: 30,
      detectionTimeoutMs: 80,
      suppressCompatibilityWarning: true,
    });

    const promise = amd.execute();
    await waitForListening(amd);
    pushTranscript(amd, 'Please leave a message after the tone');

    await expect(promise).resolves.toMatchObject({ category: AMDCategory.MACHINE_VM });
  }, 5_000);

  it('subtracts already-elapsed silence from the silence timer (onUserSpeechEnded)', async () => {
    const session = new MockSession();
    const llm = new StaticLLM(JSON.stringify({ category: AMDCategory.HUMAN, reason: 'x' }));
    const amd = new AMD(asAgentSession(session), {
      llm,
      humanSilenceThresholdMs: 300,
      detectionTimeoutMs: 5_000,
      suppressCompatibilityWarning: true,
    });

    const promise = amd.execute();
    speechStart(amd);
    // ~300ms of speech, of which 250ms of trailing silence has already elapsed
    // when the VAD declares end-of-speech.
    await new Promise((r) => setTimeout(r, 300));
    const endedAt = Date.now();
    speechEnd(amd, 250);

    const result = await promise;
    expect(result.category).toBe(AMDCategory.HUMAN);
    expect(result.reason).toBe('short_greeting');
    // human-silence window was shortened by the already-elapsed 250ms
    // (300 - 250 ≈ 50ms), so it settles well before the full 300ms threshold.
    expect(Date.now() - endedAt).toBeLessThan(250);
  }, 5_000);
});
