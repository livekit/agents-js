// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioFrame } from '@livekit/rtc-node';
import { ReadableStream } from 'node:stream/web';
import { describe, expect, it, vi } from 'vitest';
import { initializeLogger } from '../log.js';
import { Future } from '../utils.js';
import { Agent } from './agent.js';
import { AgentSession } from './agent_session.js';
import { AgentSessionEventTypes, type ConversationItemAddedEvent } from './events.js';
import { AudioOutput } from './io.js';
import { FakeLLM } from './testing/fake_llm.js';

function frame(durationMs = 20, sampleRate = 24000): AudioFrame {
  const samples = Math.floor((sampleRate * durationMs) / 1000);
  return new AudioFrame(new Int16Array(samples), sampleRate, 1, samples);
}

// Audio sink that reports the first frame as played, then (on the interruption's
// clearBuffer) reports a partial playout WITHOUT a synchronized transcript —
// the case an avatar / non-aligned output produces. Calls `onFirstFrame` once
// the first frame is captured so the test can interrupt mid-playout.
class InterruptibleOutput extends AudioOutput {
  onFirstFrame?: () => void;
  private started = false;
  constructor() {
    super(24000);
  }
  async captureFrame(f: AudioFrame): Promise<void> {
    await super.captureFrame(f);
    if (!this.started) {
      this.started = true;
      this.onPlaybackStarted(Date.now());
      this.onFirstFrame?.();
    }
  }
  flush(): void {
    super.flush();
  }
  clearBuffer(): void {
    this.onPlaybackFinished({ playbackPosition: 0.02, interrupted: true });
  }
}

// Audio sink that mimics a DataStream avatar output (waitPlaybackStart: true):
// frames are accepted faster than real time and playback-started is only
// reported LATER, via an out-of-band notification (the `lk.playback_started`
// RPC from the remote avatar worker) — typically after forwarding has already
// completed. `notifyPlaybackStarted` simulates that RPC arriving.
class DeferredStartOutput extends AudioOutput {
  onFirstFrameCaptured?: () => void;
  playbackPosition = 0;
  private captured = false;
  constructor() {
    super(24000);
  }
  async captureFrame(f: AudioFrame): Promise<void> {
    await super.captureFrame(f);
    if (!this.captured) {
      this.captured = true;
      this.onFirstFrameCaptured?.();
    }
  }
  // The remote avatar reports playback start well after frames were forwarded.
  notifyPlaybackStarted(): void {
    this.onPlaybackStarted(Date.now());
  }
  flush(): void {
    super.flush();
  }
  clearBuffer(): void {
    this.onPlaybackFinished({ playbackPosition: this.playbackPosition, interrupted: true });
  }
}

// Mimics ParticipantAudioOutput's pause gate (room_io/_output.ts): a frame
// forwarded while the output is paused awaits the gate and BAILS on interruption
// before `super.captureFrame` counts the segment (#1662). `forwardAudio` sets
// `startedForwardingAt` before awaiting captureFrame, so "forwarding started"
// must not count as playback evidence — nothing of this segment was captured.
// `clearBuffer` releases gated frames without reporting a playback event (like
// the real output when no segment is pending), leaving the PREVIOUS segment's
// lastPlaybackEvent as what waitForPlayout returns.
class PausedGateOutput extends AudioOutput {
  onGateBlocked?: () => void;
  private gateFut: Future | null = null;
  private interruptedFut = new Future();
  constructor() {
    super(24000);
  }
  pause(): void {
    this.gateFut = new Future();
  }
  async captureFrame(f: AudioFrame): Promise<void> {
    if (this.gateFut && !this.gateFut.done) {
      this.onGateBlocked?.();
      // Neither future is ever rejected in this test; catch satisfies throws-check.
      await Promise.race([this.gateFut.await, this.interruptedFut.await]).catch(() => {});
      if (this.interruptedFut.done) {
        return;
      }
    }
    await super.captureFrame(f);
  }
  flush(): void {
    super.flush();
  }
  clearBuffer(): void {
    this.interruptedFut.resolve();
  }
}

class BlockingInterruptedOutput extends AudioOutput {
  onFirstFrameCaptured?: () => void;
  clearBufferCalled = new Future<void>();
  maxPlaybackStartedListeners = 0;
  private firstSegmentFinished = false;

  constructor() {
    super(24000);
  }

  async captureFrame(f: AudioFrame): Promise<void> {
    await super.captureFrame(f);
    this.maxPlaybackStartedListeners = Math.max(
      this.maxPlaybackStartedListeners,
      this.listenerCount(AudioOutput.EVENT_PLAYBACK_STARTED),
    );
    if (this.capturedPlayoutSegments === 1) {
      this.onFirstFrameCaptured?.();
    } else {
      this.onPlaybackStarted(Date.now());
    }
  }

  flush(): void {
    super.flush();
    if (this.capturedPlayoutSegments > 1) {
      this.onPlaybackFinished({ playbackPosition: 0.02, interrupted: false });
    }
  }

  clearBuffer(): void {
    this.clearBufferCalled.resolve();
  }

  finishInterruptedSegment(): void {
    if (!this.firstSegmentFinished) {
      this.firstSegmentFinished = true;
      // DataStreamAudioReceiver serializes its RPC queue, so a delayed
      // PLAYBACK_STARTED for this segment is delivered before PLAYBACK_FINISHED.
      this.onPlaybackStarted(Date.now());
      this.onPlaybackFinished({ playbackPosition: 0, interrupted: true });
    }
  }
}

// Agent that synthesizes a few real frames for whatever text it receives, so the
// audio path produces a first frame (no TTS provider needed).
class FrameAgent extends Agent {
  constructor() {
    super({ instructions: 'test' });
  }
  async ttsNode(): Promise<ReadableStream<AudioFrame> | null> {
    return new ReadableStream<AudioFrame>({
      start(controller) {
        for (let i = 0; i < 10; i++) controller.enqueue(frame());
        controller.close();
      },
    });
  }
}

// Agent whose TTS produces no frames and stays open long enough that an
// interruption (anchored to ttsNode being invoked, fired well before the
// close) always lands mid-forwarding with zero audio captured for the segment.
class NoFrameAgent extends Agent {
  onTtsStarted?: () => void;
  constructor() {
    super({ instructions: 'test' });
  }
  async ttsNode(): Promise<ReadableStream<AudioFrame> | null> {
    this.onTtsStarted?.();
    return new ReadableStream<AudioFrame>({
      start(controller) {
        setTimeout(() => controller.close(), 500);
      },
    });
  }
}

describe('AgentActivity interrupted-speech commit', () => {
  initializeLogger({ pretty: false, level: 'silent' });

  it('commits an interrupted reply to chat ctx when no synchronized transcript is available', async () => {
    const session = new AgentSession({
      llm: new FakeLLM([{ input: 'hello', content: 'A fairly long spoken reply.' }]),
    });
    const audioOut = new InterruptibleOutput();
    session.output.audio = audioOut;
    // Interrupt the reply as soon as the first audio frame is played out.
    audioOut.onFirstFrame = () => session.interrupt({ force: true });

    const assistantMessages: { content: string; interrupted: boolean }[] = [];
    session.on(AgentSessionEventTypes.ConversationItemAdded, (ev: ConversationItemAddedEvent) => {
      if (ev.item.type === 'message' && ev.item.role === 'assistant') {
        assistantMessages.push({
          content: ev.item.textContent ?? '',
          interrupted: !!ev.item.interrupted,
        });
      }
    });

    await session.start({ agent: new FrameAgent() });
    try {
      const handle = session.generateReply({ userInput: 'hello' });
      await handle.waitForPlayout();
      await vi.waitFor(() => expect(assistantMessages.length).toBeGreaterThan(0));

      // The interrupted-but-heard reply must reach chat ctx (pre-fix it was
      // dropped because the partial branch returned `synchronizedTranscript ?? ''`,
      // committing an empty string and skipping the message).
      const msg = assistantMessages[0]!;
      expect(msg.interrupted).toBe(true);
      expect(msg.content.length).toBeGreaterThan(0);
      expect('A fairly long spoken reply.'.startsWith(msg.content)).toBe(true);
    } finally {
      await session.close();
    }
  });

  it('commits an interrupted reply when playback start is reported after forwarding completes (avatar output)', async () => {
    const session = new AgentSession({
      llm: new FakeLLM([{ input: 'hello', content: 'A fairly long spoken reply.' }]),
    });
    const audioOut = new DeferredStartOutput();
    session.output.audio = audioOut;

    // Simulate the avatar pipeline: playback starts (RPC arrives) shortly after
    // the frames were forwarded, then the user interrupts mid-playback.
    audioOut.onFirstFrameCaptured = () => {
      setTimeout(() => {
        audioOut.playbackPosition = 0.12;
        audioOut.notifyPlaybackStarted();
        setTimeout(() => session.interrupt({ force: true }), 50);
      }, 100);
    };

    const assistantMessages: { content: string; interrupted: boolean }[] = [];
    session.on(AgentSessionEventTypes.ConversationItemAdded, (ev: ConversationItemAddedEvent) => {
      if (ev.item.type === 'message' && ev.item.role === 'assistant') {
        assistantMessages.push({
          content: ev.item.textContent ?? '',
          interrupted: !!ev.item.interrupted,
        });
      }
    });

    await session.start({ agent: new FrameAgent() });
    try {
      const handle = session.generateReply({ userInput: 'hello' });
      await handle.waitForPlayout();
      await vi.waitFor(() => expect(assistantMessages.length).toBeGreaterThan(0));

      // Pre-fix, forwardAudio rejected firstFrameFut the moment forwarding
      // finished (before the deferred playback-started notification), so the
      // audibly-played reply was classified "skipped" and silently dropped from
      // the chat context (phantom utterance).
      const msg = assistantMessages[0]!;
      expect(msg.interrupted).toBe(true);
      expect(msg.content.length).toBeGreaterThan(0);
      expect('A fairly long spoken reply.'.startsWith(msg.content)).toBe(true);
    } finally {
      await session.close();
    }
  });

  it('commits an interrupted reply when only a playback position is reported (no playback-started signal)', async () => {
    const session = new AgentSession({
      llm: new FakeLLM([{ input: 'hello', content: 'A fairly long spoken reply.' }]),
    });
    const audioOut = new DeferredStartOutput();
    session.output.audio = audioOut;

    // The remote avatar never reports playback-started (or the RPC races with
    // the interruption), but its playback-finished response carries a non-zero
    // position — proof the user heard part of the reply.
    audioOut.onFirstFrameCaptured = () => {
      setTimeout(() => {
        audioOut.playbackPosition = 0.25;
        session.interrupt({ force: true });
      }, 100);
    };

    const assistantMessages: { content: string; interrupted: boolean }[] = [];
    session.on(AgentSessionEventTypes.ConversationItemAdded, (ev: ConversationItemAddedEvent) => {
      if (ev.item.type === 'message' && ev.item.role === 'assistant') {
        assistantMessages.push({
          content: ev.item.textContent ?? '',
          interrupted: !!ev.item.interrupted,
        });
      }
    });

    await session.start({ agent: new FrameAgent() });
    try {
      const handle = session.generateReply({ userInput: 'hello' });
      await handle.waitForPlayout();
      await vi.waitFor(() => expect(assistantMessages.length).toBeGreaterThan(0));

      const msg = assistantMessages[0]!;
      expect(msg.interrupted).toBe(true);
      expect(msg.content.length).toBeGreaterThan(0);
      expect('A fairly long spoken reply.'.startsWith(msg.content)).toBe(true);
    } finally {
      await session.close();
    }
  });

  it('does not commit an interrupted reply that forwarded no audio when a stale playback position exists', async () => {
    const session = new AgentSession({
      llm: new FakeLLM([{ input: 'hello', content: 'A reply that was never spoken.' }]),
    });
    const audioOut = new DeferredStartOutput();
    session.output.audio = audioOut;

    // A previously played segment leaves a non-zero lastPlaybackEvent behind.
    // waitForPlayout returns it immediately for a segment that captured no
    // frames — the playback position must not be attributed to that segment.
    await audioOut.captureFrame(frame());
    audioOut.flush();
    audioOut.onPlaybackFinished({ playbackPosition: 0.5, interrupted: false });

    const assistantMessages: { content: string; interrupted: boolean }[] = [];
    session.on(AgentSessionEventTypes.ConversationItemAdded, (ev: ConversationItemAddedEvent) => {
      if (ev.item.type === 'message' && ev.item.role === 'assistant') {
        assistantMessages.push({
          content: ev.item.textContent ?? '',
          interrupted: !!ev.item.interrupted,
        });
      }
    });

    const agent = new NoFrameAgent();
    // Anchor the interruption to TTS starting, so it always lands while the
    // segment is mid-forwarding (zero frames captured, stream still open).
    agent.onTtsStarted = () => setTimeout(() => session.interrupt({ force: true }), 150);

    await session.start({ agent });
    try {
      const handle = session.generateReply({ userInput: 'hello' });
      await handle.waitForPlayout();

      // Close drains the reply task fully — the interrupted-commit block (if
      // it were to run) has fired by the time close resolves. Nothing was
      // heard: the reply must not be committed on the strength of the stale
      // playback position.
      await session.close();
      expect(assistantMessages).toHaveLength(0);
    } finally {
      await session.close();
    }
  });

  it('does not commit a reply whose first frame bailed at a pause gate (stale playback position)', async () => {
    const session = new AgentSession({
      llm: new FakeLLM([{ input: 'hello', content: 'A reply that was never spoken.' }]),
    });
    const audioOut = new PausedGateOutput();
    session.output.audio = audioOut;

    // A previously played segment leaves a non-zero lastPlaybackEvent behind.
    await audioOut.captureFrame(frame());
    audioOut.flush();
    audioOut.onPlaybackFinished({ playbackPosition: 0.5, interrupted: false });

    // The output is paused (false-interruption pause during the thinking state):
    // the reply's first frame will block at the gate, never reaching
    // super.captureFrame — so the segment count is never bumped and waitForPlayout
    // returns the stale event above. Forwarding DID start (`startedForwardingAt`
    // is set), which is exactly why forwarding-started must not gate the commit.
    audioOut.pause();
    // A genuine interruption arrives while the frame is blocked at the gate.
    audioOut.onGateBlocked = () => session.interrupt({ force: true });

    const assistantMessages: { content: string; interrupted: boolean }[] = [];
    session.on(AgentSessionEventTypes.ConversationItemAdded, (ev: ConversationItemAddedEvent) => {
      if (ev.item.type === 'message' && ev.item.role === 'assistant') {
        assistantMessages.push({
          content: ev.item.textContent ?? '',
          interrupted: !!ev.item.interrupted,
        });
      }
    });

    await session.start({ agent: new FrameAgent() });
    try {
      const handle = session.generateReply({ userInput: 'hello' });
      await handle.waitForPlayout();

      // Nothing of this reply was captured, let alone played: the stale 0.5s
      // position from the previous segment must not commit it as 'partial'.
      await session.close();
      expect(assistantMessages).toHaveLength(0);
    } finally {
      await session.close();
    }
  }, 15_000);

  it('finishes interrupted generation cleanup before authorizing the next reply', async () => {
    const session = new AgentSession({
      llm: new FakeLLM([
        { input: 'first', content: 'First reply.' },
        { input: 'second', content: 'Second reply.' },
      ]),
    });
    const audioOut = new BlockingInterruptedOutput();
    const agent = new FrameAgent();
    session.output.audio = audioOut;
    let second: ReturnType<AgentSession['generateReply']> | undefined;
    audioOut.onFirstFrameCaptured = () => {
      session.interrupt();
      second = session.generateReply({ userInput: 'second' });
    };

    await session.start({ agent });
    try {
      const first = session.generateReply({ userInput: 'first' });

      await audioOut.clearBufferCalled.await;
      await new Promise<void>((resolve) => setTimeout(resolve, 50));

      // The old segment's PLAYBACK_STARTED listener must be settled and detached
      // before the shared output accepts frames for the next reply.
      expect(audioOut.capturedPlayoutSegments).toBe(1);

      audioOut.finishInterruptedSegment();
      await first.waitForPlayout();
      if (!second) {
        throw new Error('second reply was not scheduled');
      }
      await second.waitForPlayout();
      expect(audioOut.capturedPlayoutSegments).toBe(2);
      expect(audioOut.maxPlaybackStartedListeners).toBe(1);
    } finally {
      audioOut.finishInterruptedSegment();
      await session.close();
    }
  });
});
