// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression test for livekit/agents-js#2065.
 *
 * When a pipeline reply is interrupted before its playout has started, the
 * reply task parks on `audioOutput.waitForPlayout()` inside its interrupted
 * branch: the playback-finished event never fires (playback never began) and
 * the reply abort controller is only aborted by code that runs after the
 * segment loop returns — which is blocked on that same await. The handle's
 * generation future then never settles, `mainTask` never advances past the
 * wedged handle, and the agent stays mute for the rest of the session.
 *
 * The fix bounds mainTask's interrupted-generation wait and, on timeout,
 * cancels the handle's tasks; their abort path runs the normal
 * interrupted-reply cleanup, which settles the generation future and lets the
 * scheduler advance to the next speech.
 */
import { AudioFrame } from '@livekit/rtc-node';
import { ReadableStream } from 'node:stream/web';
import { describe, expect, it, vi } from 'vitest';
import { initializeLogger } from '../log.js';
import { Agent } from './agent.js';
import { AgentSession } from './agent_session.js';
import { AudioOutput } from './io.js';
import { FakeLLM } from './testing/fake_llm.js';

function frame(durationMs = 20, sampleRate = 24000): AudioFrame {
  const samples = Math.floor((sampleRate * durationMs) / 1000);
  return new AudioFrame(new Int16Array(samples), sampleRate, 1, samples);
}

// Audio sink where playback never starts: frames are accepted but no
// playback-started/-finished event is ever reported — the interruption lands
// before the output began playing. `waitForPlayout()` on a captured segment
// therefore never resolves, which is the wedge condition of #2065. Real
// outputs behave this way when the interrupt wins the race against the first
// played frame (e.g. a reply generated in an agent-handoff onEnter while the
// user is still speaking).
class NeverStartsOutput extends AudioOutput {
  onFrameCaptured?: () => void;
  framesCaptured = 0;

  constructor() {
    super(24000);
  }

  async captureFrame(f: AudioFrame): Promise<void> {
    await super.captureFrame(f);
    this.framesCaptured++;
    this.onFrameCaptured?.();
  }

  flush(): void {
    super.flush();
  }

  clearBuffer(): void {
    // Playback never started, so there is no playback event to report.
  }
}

// Agent that synthesizes a few real frames for whatever text it receives, so
// the audio path produces frames without a TTS provider.
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

describe('pre-playout interruption (#2065)', () => {
  initializeLogger({ pretty: false, level: 'silent' });

  it('unwedges the speech scheduler when a reply is interrupted before playout starts', async () => {
    const session = new AgentSession({
      llm: new FakeLLM([
        { input: 'hello', content: 'A reply that never reaches the speaker.' },
        { input: 'again', content: 'A follow-up reply.' },
      ]),
    });
    const audioOut = new NeverStartsOutput();
    session.output.audio = audioOut;

    // Interrupt (non-force, like a new user turn) as soon as the first frame
    // is captured — before the output ever reports playback start.
    let interruptedOnce = false;
    audioOut.onFrameCaptured = () => {
      if (!interruptedOnce) {
        interruptedOnce = true;
        session.interrupt();
      }
    };

    await session.start({ agent: new FrameAgent() });
    try {
      const wedged = session.generateReply({ userInput: 'hello' });
      // Pre-fix, the interrupted handle's generation never settles and this
      // await hangs until the test times out.
      await wedged.waitForPlayout();

      // The scheduler must have moved past the wedged handle: a follow-up
      // reply gets authorized and its audio reaches the output.
      const framesBefore = audioOut.framesCaptured;
      session.generateReply({ userInput: 'again' });
      await vi.waitFor(() => expect(audioOut.framesCaptured).toBeGreaterThan(framesBefore), {
        timeout: 5000,
      });
    } finally {
      await session.close();
    }
  }, 15000);
});
