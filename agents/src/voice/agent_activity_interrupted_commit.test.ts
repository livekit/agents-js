// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioFrame } from '@livekit/rtc-node';
import { ReadableStream } from 'node:stream/web';
import { describe, expect, it, vi } from 'vitest';
import { initializeLogger } from '../log.js';
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
});
