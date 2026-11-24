// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioFrame } from '@livekit/rtc-node';
import { ReadableStream, type ReadableStreamDefaultController } from 'node:stream/web';
import { describe, expect, it } from 'vitest';
import { type ChatContext, FunctionCall } from '../llm/chat_context.js';
import { LLM, LLMStream } from '../llm/llm.js';
import type { ToolChoice } from '../llm/tool_context.js';
import { type ToolContextLike, handoff, tool } from '../llm/tool_context.js';
import { initializeLogger } from '../log.js';
import { type SpeechEvent, SpeechEventType } from '../stt/stt.js';
import { FakeSTT } from '../stt/testing/fake_stt.js';
import { VAD, VADStream } from '../vad.js';
import { Agent } from './agent.js';
import { AgentSession } from './agent_session.js';
import { AudioInput } from './io.js';

// Harness adapted from the reproduction in https://github.com/livekit/agents-js/issues/2717

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${cond.toString()}`);
    await sleep(10);
  }
}

/** VAD that never fires, so end of turn comes from STT finals and endpointing. */
class SilentVADStream extends VADStream {
  constructor(vad: VAD) {
    super(vad);
    void (async () => {
      try {
        while (!this.closed && !(await this.inputReader.read()).done) {}
      } catch {}
    })();
  }
}

class SilentVAD extends VAD {
  label = 'silent-vad';
  constructor() {
    super({ updateInterval: 1 });
  }
  stream(): VADStream {
    return new SilentVADStream(this);
  }
}

class PushAudioInput extends AudioInput {
  controller!: ReadableStreamDefaultController<AudioFrame>;
  constructor() {
    super();
    this.multiStream.addInputStream(
      new ReadableStream<AudioFrame>({ start: (c) => void (this.controller = c) }),
    );
  }
}

/**
 * Calls the `to_b` handoff tool on every user turn, with a unique call id per call. A reply to
 * tool output calls `lookup` whenever the tool choice allows it, so a test can see whether the
 * reply was allowed to call tools.
 */
class HandoffEveryTurnLLM extends LLM {
  seq = 0;
  toolReplyChoices: Array<ToolChoice | undefined> = [];
  label() {
    return 'handoff-every-turn';
  }
  chat({
    chatCtx,
    toolCtx,
    toolChoice,
  }: {
    chatCtx: ChatContext;
    toolCtx?: ToolContextLike;
    toolChoice?: ToolChoice;
  }) {
    if (chatCtx.items.at(-1)?.type === 'function_call_output') {
      this.toolReplyChoices.push(toolChoice);
    }
    return new HandoffStream(this, toolChoice, this, {
      chatCtx,
      toolCtx,
      connOptions: { maxRetry: 0, retryIntervalMs: 0, timeoutMs: 10_000 },
    });
  }
}

class HandoffStream extends LLMStream {
  constructor(
    private readonly owner: HandoffEveryTurnLLM,
    private readonly toolChoice: ToolChoice | undefined,
    ...args: ConstructorParameters<typeof LLMStream>
  ) {
    super(...args);
  }

  protected async run() {
    const last = this.chatCtx.items.at(-1);
    if (last?.type === 'function_call_output') {
      if (this.toolChoice === 'none') return;
      this.queue.put({
        id: 'x',
        delta: {
          role: 'assistant',
          toolCalls: [
            FunctionCall.create({
              callId: `call_${++this.owner.seq}`,
              name: 'lookup',
              args: '{}',
            }),
          ],
        },
      });
      return;
    }
    if (last?.type !== 'message' || last.role !== 'user') return;
    this.queue.put({
      id: 'x',
      delta: {
        role: 'assistant',
        toolCalls: [
          FunctionCall.create({ callId: `call_${++this.owner.seq}`, name: 'to_b', args: '{}' }),
        ],
      },
    });
  }
}

/** Starts a session on `agent` whose user turns come from scripted STT finals. */
async function startSession(agent: Agent, llm: LLM) {
  const stt = new FakeSTT({
    label: 'scripted-stt',
    capabilities: { streaming: true, interimResults: true, alignedTranscript: 'word' },
  });
  const streams: Array<{ stream: unknown; openedAt: number }> = [];
  void (async () => {
    for await (const stream of stt.streamCh) streams.push({ stream, openedAt: Date.now() });
  })();
  const userSays = (text: string) => {
    const { stream, openedAt } = streams[0]!;
    const end = (Date.now() - openedAt) / 1000;
    (stream as { queue: { put(ev: SpeechEvent): void } }).queue.put({
      type: SpeechEventType.FINAL_TRANSCRIPT,
      alternatives: [
        {
          text,
          language: 'en' as never,
          startTime: Math.max(0, end - 0.4),
          endTime: end,
          confidence: 0.95,
        },
      ],
    });
  };

  const session = new AgentSession({
    stt,
    vad: new SilentVAD(),
    llm,
    turnHandling: { endpointing: { minDelay: 300, maxDelay: 2_000 } },
  });
  const audio = new PushAudioInput();
  session.input.audio = audio;
  await session.start({ agent });
  const pump = setInterval(() => {
    const n = 800; // 50ms of 16kHz silence
    audio.controller.enqueue(new AudioFrame(new Int16Array(n), 16_000, 1, n));
  }, 50);
  await waitFor(() => streams.length > 0);
  await sleep(200);
  const stop = async () => {
    clearInterval(pump);
    await session.close();
  };
  return { session, userSays, stop };
}

describe('overlapping handoff tool calls', () => {
  initializeLogger({ pretty: false, level: 'silent' });

  it('applies only the first handoff when a second one returns from the outgoing agent', async () => {
    const entered: Agent[] = [];
    class B extends Agent {
      async onEnter() {
        entered.push(this);
      }
    }

    // each invocation of the handoff tool waits until the test releases it
    const releases: Array<() => void> = [];
    const createdB: B[] = [];
    const a = new Agent({
      instructions: 'A',
      tools: {
        to_b: tool({
          description: 'Hand off to B',
          execute: async () => {
            await new Promise<void>((resolve) => releases.push(resolve));
            const b = new B({ instructions: 'B' });
            createdB.push(b);
            return handoff({ agent: b });
          },
        }),
      },
    });

    const { session, userSays, stop } = await startSession(a, new HandoffEveryTurnLLM());
    try {
      userSays('hello');
      await waitFor(() => releases.length === 1); // first handoff tool is running

      userSays('yes');
      await waitFor(() => releases.length === 2); // second handoff tool started on agent A

      // the first handoff starts the A -> B transition, which drains A and so waits for the
      // second tool, whose handoff result then comes back from the outgoing agent
      releases[0]!();
      await sleep(100);
      releases[1]!();
      await waitFor(() => entered.length >= 1);
      await sleep(1_000); // leave time for a second, unwanted transition to run
    } finally {
      // never leave a tool pending, or session.close() waits on it
      for (const release of releases) release();
      await stop();
    }

    expect(createdB).toHaveLength(2);
    expect(entered).toHaveLength(1); // B.onEnter ran once
    expect(entered[0]).toBe(createdB[0]); // and on the first handoff's agent
    expect(session.currentAgent).toBe(createdB[0]);
  }, 30_000);
  it('does not let the outgoing agent call tools when it replies to a stale handoff', async () => {
    const entered: Agent[] = [];
    class Dest extends Agent {
      async onEnter() {
        entered.push(this);
      }
    }

    let releaseExit!: () => void;
    const exitReleased = new Promise<void>((resolve) => (releaseExit = resolve));
    let exitStarted = false;
    class A extends Agent {
      async onExit() {
        exitStarted = true;
        await exitReleased; // a slow onExit keeps the outgoing activity in its handoff window
      }
    }

    const releases: Array<() => void> = [];
    let lookups = 0;
    const b = new Dest({ instructions: 'B' });
    const c = new Dest({ instructions: 'C' });
    const a = new A({
      instructions: 'A',
      tools: {
        to_b: tool({
          description: 'Hand off to B',
          execute: async () => {
            const n = releases.length;
            await new Promise<void>((resolve) => releases.push(resolve));
            // the second call returns a value, so its output asks for a reply from A
            return n === 0
              ? handoff({ agent: b })
              : handoff({ agent: c, returns: 'Transfer complete.' });
          },
        }),
        lookup: tool({
          description: 'Look something up',
          execute: async () => {
            lookups += 1;
            return 'nothing found';
          },
        }),
      },
    });

    const llm = new HandoffEveryTurnLLM();
    const { session, userSays, stop } = await startSession(a, llm);
    try {
      userSays('hello');
      await waitFor(() => releases.length === 1);
      userSays('yes');
      await waitFor(() => releases.length === 2);

      releases[0]!(); // A -> B starts, and A.onExit holds the transition open
      await waitFor(() => exitStarted);
      releases[1]!(); // the stale handoff to C returns while A is still handing off
      await waitFor(() => llm.toolReplyChoices.length >= 1);
      await sleep(500); // leave time for a tool call from that reply to run
      releaseExit();
      await waitFor(() => entered.length >= 1);
      await sleep(500);
    } finally {
      for (const release of releases) release();
      releaseExit();
      await stop();
    }

    expect(llm.toolReplyChoices).toEqual(['none']); // the reply to the stale handoff has no tools
    expect(lookups).toBe(0);
    expect(entered).toEqual([b]);
    expect(session.currentAgent).toBe(b);
  }, 30_000);
});
