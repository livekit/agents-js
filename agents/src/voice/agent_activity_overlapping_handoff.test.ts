// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioFrame } from '@livekit/rtc-node';
import { ReadableStream, type ReadableStreamDefaultController } from 'node:stream/web';
import { describe, expect, it } from 'vitest';
import { type ChatContext, FunctionCall } from '../llm/chat_context.js';
import { LLM, LLMStream } from '../llm/llm.js';
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

/** Calls the `to_b` handoff tool on every user turn, with a unique call id per call. */
class HandoffEveryTurnLLM extends LLM {
  seq = 0;
  label() {
    return 'handoff-every-turn';
  }
  chat({ chatCtx, toolCtx }: { chatCtx: ChatContext; toolCtx?: ToolContextLike }) {
    return new HandoffStream(this, this, {
      chatCtx,
      toolCtx,
      connOptions: { maxRetry: 0, retryIntervalMs: 0, timeoutMs: 10_000 },
    });
  }
}

class HandoffStream extends LLMStream {
  constructor(
    private readonly owner: HandoffEveryTurnLLM,
    ...args: ConstructorParameters<typeof LLMStream>
  ) {
    super(...args);
  }

  protected async run() {
    const last = this.chatCtx.items.at(-1);
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
      llm: new HandoffEveryTurnLLM(),
      turnHandling: { endpointing: { minDelay: 300, maxDelay: 2_000 } },
    });
    const audio = new PushAudioInput();
    session.input.audio = audio;
    await session.start({ agent: a });
    const pump = setInterval(() => {
      const n = 800; // 50ms of 16kHz silence
      audio.controller.enqueue(new AudioFrame(new Int16Array(n), 16_000, 1, n));
    }, 50);
    try {
      await waitFor(() => streams.length > 0);
      await sleep(200);

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
      clearInterval(pump);
      await session.close();
    }

    expect(createdB).toHaveLength(2);
    expect(entered).toHaveLength(1); // B.onEnter ran once
    expect(entered[0]).toBe(createdB[0]); // and on the first handoff's agent
    expect(session.currentAgent).toBe(createdB[0]);
  }, 30_000);
});
