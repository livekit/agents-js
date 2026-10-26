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

// Audio sink that starts playback but can never finish it — the shape a room
// disconnect produces: waitForPlayout() promises stop resolving, clearBuffer()
// has nobody left to report a final position. Pre-fix, closing the session in
// this state parked the pipeline reply task forever and the in-flight
// assistant turn was dropped from chat ctx entirely (#2041).
class DeadRoomOutput extends AudioOutput {
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
    // Room is gone: playback finished is never reported.
  }
}

// Agent that synthesizes a few real frames for whatever text it receives, so
// the audio path produces a first frame (no TTS provider needed).
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

describe('AgentActivity close mid-playout commit', () => {
  initializeLogger({ pretty: false, level: 'silent' });

  it('commits the in-flight assistant turn when the session closes mid-playout', async () => {
    const session = new AgentSession({
      llm: new FakeLLM([{ input: 'hello', content: 'A fairly long spoken reply.' }]),
    });
    const audioOut = new DeadRoomOutput();
    session.output.audio = audioOut;

    const assistantMessages: { content: string; interrupted: boolean }[] = [];
    session.on(AgentSessionEventTypes.ConversationItemAdded, (ev: ConversationItemAddedEvent) => {
      if (ev.item.type === 'message' && ev.item.role === 'assistant') {
        assistantMessages.push({
          content: ev.item.textContent ?? '',
          interrupted: !!ev.item.interrupted,
        });
      }
    });

    // Close the session as soon as the first audio frame plays — the
    // "visitor closed the tab mid-answer" scenario.
    let closePromise: Promise<void> | undefined;
    audioOut.onFirstFrame = () => {
      closePromise = session.close();
    };

    await session.start({ agent: new FrameAgent() });
    session.generateReply({ userInput: 'hello' });

    await vi.waitFor(() => expect(closePromise).toBeDefined(), { timeout: 5000 });
    await closePromise!;

    // The partially played turn must reach chat ctx as an interrupted message
    // (pre-fix: zero assistant items — the turn vanished).
    expect(assistantMessages.length).toBeGreaterThan(0);
    const msg = assistantMessages[0]!;
    expect(msg.interrupted).toBe(true);
    expect(msg.content.length).toBeGreaterThan(0);
    expect('A fairly long spoken reply.'.startsWith(msg.content)).toBe(true);
  });
});
