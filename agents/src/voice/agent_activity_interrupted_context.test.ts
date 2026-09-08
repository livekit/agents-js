// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioFrame } from '@livekit/rtc-node';
import { ReadableStream } from 'node:stream/web';
import { expect, it, vi } from 'vitest';
import type { ChatContext } from '../llm/chat_context.js';
import { tool } from '../llm/tool_context.js';
import { Future } from '../utils.js';
import { Agent, type AgentOptions } from './agent.js';
import { AgentSession } from './agent_session.js';
import { AudioOutput } from './io.js';
import { FakeLLM, type FakeLLMResponse } from './testing/fake_llm.js';

const INITIAL = 'Find a time.';
const CORRECTION = 'Actually, a different day.';
const SPOKEN = 'The appointment is available';
const UNSPOKEN = ' on Thursday at ten.';

class CapturingLLM extends FakeLLM {
  readonly requests: ChatContext[] = [];

  constructor(
    responses: FakeLLMResponse[] = [
      { input: INITIAL, content: SPOKEN + UNSPOKEN },
      { input: CORRECTION, content: 'Which day works?' },
      { input: 'Friday instead.', content: 'Let me check Friday.' },
    ],
  ) {
    super(responses);
  }

  override chat(options: Parameters<FakeLLM['chat']>[0]) {
    this.requests.push(options.chatCtx.copy());
    return super.chat(options);
  }
}

class FrameAgent extends Agent {
  constructor(tools?: AgentOptions['tools']) {
    super({ instructions: 'Answer the caller.', tools });
  }

  override async ttsNode() {
    return new ReadableStream<AudioFrame>({
      start(controller) {
        controller.enqueue(new AudioFrame(new Int16Array(480), 24_000, 1, 480));
        controller.close();
      },
    });
  }
}

class DelayedPlaybackOutput extends AudioOutput {
  captured = false;
  cleared = false;
  released = false;

  constructor(private readonly firstPlaybackStarts = true) {
    super(24_000);
  }

  override async captureFrame(frame: AudioFrame) {
    await super.captureFrame(frame);
    this.captured = true;
    if (this.firstPlaybackStarts || this.released) this.onPlaybackStarted(Date.now());
  }

  override flush() {
    super.flush();
    if (this.released) {
      this.onPlaybackFinished({ playbackPosition: 0.02, interrupted: false });
    }
  }

  override clearBuffer() {
    this.cleared = true;
    // Hold the completion event until the test explicitly releases it.
  }

  releasePlayback(interrupted = true) {
    if (this.released) return;
    this.released = true;
    this.onPlaybackFinished({
      playbackPosition: this.firstPlaybackStarts ? 0.02 : 0,
      interrupted,
      synchronizedTranscript: this.firstPlaybackStarts
        ? interrupted
          ? SPOKEN
          : SPOKEN + UNSPOKEN
        : undefined,
    });
    // A watchdog may authorize new audio before the old completion arrives.
    // Finish any subsequently buffered segment too, as a real sink would.
    while (this.pendingPlayoutSegments > 0) {
      this.onPlaybackFinished({ playbackPosition: 0.02, interrupted: false });
    }
  }
}

function userTurn(newTranscript: string) {
  return {
    endOfUtteranceDelay: 0,
    newTranscript,
    startedSpeakingAt: undefined,
    stoppedSpeakingAt: undefined,
    transcriptionDelay: 0,
    transcriptConfidence: 0.99,
  };
}

function assistantText(context: ChatContext) {
  return context.items.flatMap((item) =>
    item.type === 'message' && item.role === 'assistant' ? [item.textContent ?? ''] : [],
  );
}

async function startHarness({
  preemptive = false,
  llm = new CapturingLLM(),
  output = new DelayedPlaybackOutput(),
  agent = new FrameAgent(),
} = {}) {
  const session = new AgentSession({
    llm,
    turnHandling: { preemptiveGeneration: { enabled: preemptive } },
  });
  session.output.audio = output;
  await session.start({ agent });
  const activity = await session.waitForIdle();
  return { session, activity, llm, output, agent };
}

const cases = [false, true].flatMap((preemptive) => [
  { mode: 'interrupt_on_user_turn', preemptive },
  { mode: 'interrupt_before_user_turn', preemptive },
  { mode: 'completed_speech_control', preemptive },
]);

it.each(cases)(
  'preserves prior spoken context: $mode / preemptive=$preemptive',
  async ({ mode, preemptive }) => {
    const { session, activity, llm, output, agent } = await startHarness({ preemptive });
    try {
      const firstReply = session.generateReply({ userInput: INITIAL });
      await vi.waitFor(() => expect(output.captured).toBe(true));
      if (mode === 'completed_speech_control') {
        output.releasePlayback(false);
        await firstReply.waitForPlayout();
      } else if (mode === 'interrupt_before_user_turn') {
        session.interrupt();
        await vi.waitFor(() => expect(output.cleared).toBe(true));
      }
      if (preemptive) {
        activity.onPreemptiveGeneration(userTurn(CORRECTION));
        if (mode !== 'interrupt_on_user_turn') {
          await vi.waitFor(() => expect(llm.requests.length).toBeGreaterThan(1));
        }
      }
      await activity.onEndOfTurn(userTurn(CORRECTION));
      if (mode !== 'completed_speech_control') {
        await vi.waitFor(() => expect(output.cleared).toBe(true));
      }
      output.releasePlayback();
      await session.waitForIdle();
      expect(llm.requests.length).toBeGreaterThanOrEqual(2);
      const nextRequest = assistantText(llm.requests.at(-1)!);
      const finalHistory = assistantText(agent.chatCtx.copy());
      const expected = mode === 'completed_speech_control' ? SPOKEN + UNSPOKEN : SPOKEN;
      expect(finalHistory).toContain(expected);
      expect(nextRequest).toContain(expected);
      if (mode !== 'completed_speech_control') {
        expect(nextRequest.some((text) => text.includes(UNSPOKEN))).toBe(false);
      }
      expect(nextRequest.filter((text) => text === expected)).toHaveLength(1);
    } finally {
      output.releasePlayback();
      await session.close();
    }
  },
);

it('does not wait for an unauthorized generation or commit unplayed speech', async () => {
  const { session, activity, llm, output, agent } = await startHarness();
  try {
    activity.pauseReplyAuthorization();
    const first = session.generateReply({ userInput: INITIAL });
    await vi.waitFor(() => expect(llm.requests).toHaveLength(1));
    expect(first._hasGenerations).toBe(false);
    await activity.onEndOfTurn(userTurn(CORRECTION));
    await vi.waitFor(() => expect(llm.requests).toHaveLength(2));
    activity.resumeReplyAuthorization();
    output.released = true;
    await session.waitForIdle();
    expect(assistantText(llm.requests[1]!)).toEqual([]);
    expect(assistantText(agent.chatCtx)).not.toContain(SPOKEN + UNSPOKEN);
  } finally {
    activity.resumeReplyAuthorization();
    output.releasePlayback();
    await session.close();
  }
});

it('excludes a captured segment that never started playing', async () => {
  const { session, activity, llm, output } = await startHarness({
    output: new DelayedPlaybackOutput(false),
  });
  try {
    session.generateReply({ userInput: INITIAL });
    await vi.waitFor(() => expect(output.captured).toBe(true));
    await activity.onEndOfTurn(userTurn(CORRECTION));
    await vi.waitFor(() => expect(output.cleared).toBe(true));
    output.releasePlayback();
    await session.waitForIdle();
    expect(assistantText(llm.requests.at(-1)!)).toEqual([]);
  } finally {
    output.releasePlayback();
    await session.close();
  }
});

it('keeps the next turn live when playback cleanup needs the interruption watchdog', async () => {
  const { session, activity, llm, output } = await startHarness();
  try {
    session.generateReply({ userInput: INITIAL });
    await vi.waitFor(() => expect(output.captured).toBe(true));
    await activity.onEndOfTurn(userTurn(CORRECTION));
    await vi.waitFor(() => expect(output.cleared).toBe(true));
    // The sink withholds completion entirely. The existing watchdog must still
    // release the generation wait; without playback metadata no exact prefix is known.
    await vi.waitFor(() => expect(llm.requests).toHaveLength(2), { timeout: 8_000 });
    output.releasePlayback();
    await session.waitForIdle();
  } finally {
    output.releasePlayback();
    await session.close();
  }
}, 15_000);

it('can close while the next user turn awaits interrupted playback cleanup', async () => {
  const { session, activity, llm, output, agent } = await startHarness();
  try {
    session.generateReply({ userInput: INITIAL });
    await vi.waitFor(() => expect(output.captured).toBe(true));
    await activity.onEndOfTurn(userTurn(CORRECTION));
    await vi.waitFor(() => expect(output.cleared).toBe(true));
    await session.close();
    expect(llm.requests).toHaveLength(1);
    expect(
      agent.chatCtx.items.some(
        (item) =>
          item.type === 'message' && item.role === 'user' && item.textContent === CORRECTION,
      ),
    ).toBe(true);
  } finally {
    output.releasePlayback();
    await session.close();
  }
});

it('waits for speech commitment without waiting for an interrupted tool to settle', async () => {
  const toolStarted = new Future<void>();
  const toolResult = new Future<string>();
  const { session, activity, llm, output } = await startHarness({
    agent: new FrameAgent({
      lookup: tool({
        description: 'Look up a time',
        execute: async () => {
          toolStarted.resolve();
          return toolResult.await;
        },
      }),
    }),
    llm: new CapturingLLM([
      { input: INITIAL, content: SPOKEN + UNSPOKEN, toolCalls: [{ name: 'lookup', args: {} }] },
      { input: CORRECTION, content: 'Which day works?' },
    ]),
  });
  try {
    session.generateReply({ userInput: INITIAL });
    await vi.waitFor(() => expect(output.captured).toBe(true));
    await toolStarted.await;
    await activity.onEndOfTurn(userTurn(CORRECTION));
    await vi.waitFor(() => expect(output.cleared).toBe(true));
    output.releasePlayback();
    await vi.waitFor(() => expect(llm.requests).toHaveLength(2));
    expect(toolResult.done).toBe(false);
    expect(assistantText(llm.requests[1]!)).toEqual([SPOKEN]);
  } finally {
    toolResult.resolve('Available');
    output.releasePlayback();
    await session.close();
  }
});

it('preserves the committed prefix across consecutive caller corrections', async () => {
  const { session, activity, llm, output } = await startHarness();
  try {
    session.generateReply({ userInput: INITIAL });
    await vi.waitFor(() => expect(output.captured).toBe(true));
    await activity.onEndOfTurn(userTurn(CORRECTION));
    await vi.waitFor(() => expect(output.cleared).toBe(true));
    await activity.onEndOfTurn(userTurn('Friday instead.'));
    output.releasePlayback();
    await session.waitForIdle();
    const latest = llm.requests.at(-1)!;
    expect(
      latest.items.some(
        (item) =>
          item.type === 'message' && item.role === 'user' && item.textContent === 'Friday instead.',
      ),
    ).toBe(true);
    expect(assistantText(latest).filter((text) => text === SPOKEN)).toHaveLength(1);
  } finally {
    output.releasePlayback();
    await session.close();
  }
});
