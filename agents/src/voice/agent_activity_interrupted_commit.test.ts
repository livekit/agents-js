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
});
