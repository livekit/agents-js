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
import { AudioOutput, TextOutput, type TimedString } from './io.js';
import { FakeLLM } from './testing/fake_llm.js';
import { TranscriptionSynchronizer } from './transcription/synchronizer.js';

function frame(durationMs = 20, sampleRate = 24000): AudioFrame {
  const samples = Math.floor((sampleRate * durationMs) / 1000);
  return new AudioFrame(new Int16Array(samples), sampleRate, 1, samples);
}

// Plays a flushed segment out in real time from its first frame, and reports an interrupted
// finish synchronously from clearBuffer().
class PlayoutOutput extends AudioOutput {
  onFirstFrame?: () => void;
  private segmentStarted = false;
  private startedAt = 0;
  private pushedMs = 0;
  private finishTimer?: ReturnType<typeof setTimeout>;

  constructor() {
    super(24000);
  }

  async captureFrame(f: AudioFrame): Promise<void> {
    await super.captureFrame(f);
    this.pushedMs += (f.samplesPerChannel / f.sampleRate) * 1000;
    if (!this.segmentStarted) {
      this.segmentStarted = true;
      this.startedAt = Date.now();
      this.onPlaybackStarted(this.startedAt);
      this.onFirstFrame?.();
    }
  }

  flush(): void {
    super.flush();
    if (this.pendingPlayoutSegments === 0 || this.finishTimer) return;
    const remainingMs = Math.max(this.startedAt + this.pushedMs - Date.now(), 0);
    this.finishTimer = setTimeout(() => this.finish(false), remainingMs);
  }

  clearBuffer(): void {
    if (this.pendingPlayoutSegments === 0) return;
    this.finish(true);
  }

  private finish(interrupted: boolean): void {
    clearTimeout(this.finishTimer);
    this.finishTimer = undefined;
    const playedMs = Math.min(Date.now() - this.startedAt, this.pushedMs);
    this.segmentStarted = false;
    this.pushedMs = 0;
    this.onPlaybackFinished({ playbackPosition: playedMs / 1000, interrupted });
  }
}

class NullTextOutput extends TextOutput {
  async captureText(_text: string | TimedString): Promise<void> {}
  flush(): void {}
}

class FrameAgent extends Agent {
  constructor() {
    super({ instructions: 'test' });
  }
  async ttsNode(): Promise<ReadableStream<AudioFrame> | null> {
    return new ReadableStream<AudioFrame>({
      start(controller) {
        for (let i = 0; i < 50; i++) controller.enqueue(frame());
        controller.close();
      },
    });
  }
}

describe('AgentActivity with a TranscriptionSynchronizer', () => {
  initializeLogger({ pretty: false, level: 'silent' });

  it('commits each interrupted reply with its own text', async () => {
    const session = new AgentSession({
      llm: new FakeLLM([
        // the text stream stays open after its audio has played out
        { input: 'one', content: 'Turn one reply.', duration: 1500 },
        { input: 'two', content: 'Turn two reply.' },
        { input: 'three', content: 'Turn three is a longer reply that gets cut off.' },
      ]),
    });
    const playout = new PlayoutOutput();
    const synchronizer = new TranscriptionSynchronizer(playout, new NullTextOutput());
    session.output.audio = synchronizer.audioOutput;
    session.output.transcription = synchronizer.textOutput;

    const assistant: { text: string; interrupted: boolean }[] = [];
    session.on(AgentSessionEventTypes.ConversationItemAdded, (ev: ConversationItemAddedEvent) => {
      if (ev.item.type === 'message' && ev.item.role === 'assistant') {
        assistant.push({ text: ev.item.textContent ?? '', interrupted: !!ev.item.interrupted });
      }
    });

    await session.start({ agent: new FrameAgent() });
    try {
      await session.generateReply({ userInput: 'one' }).waitForPlayout();
      await session.generateReply({ userInput: 'two' }).waitForPlayout();

      // the user barges in halfway through the third reply
      playout.onFirstFrame = () => {
        playout.onFirstFrame = undefined;
        setTimeout(() => session.interrupt({ force: true }), 500);
      };
      await session.generateReply({ userInput: 'three' }).waitForPlayout();
      await vi.waitFor(() => expect(assistant).toHaveLength(3));

      // pre-fix the third reply was committed with the second reply's text
      const [, second, third] = assistant;
      expect(second).toEqual({ text: 'Turn two reply.', interrupted: false });
      expect(third!.interrupted).toBe(true);
      expect(third!.text).not.toBe('');
      expect('Turn three is a longer reply that gets cut off.'.startsWith(third!.text)).toBe(true);
    } finally {
      await session.close();
      await synchronizer.close();
    }
  });
});
