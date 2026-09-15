// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression test for livekit/agents-js#2065.
 *
 * A reply that is interrupted before its audio ever starts playing can leave the pipeline
 * reply task parked in `forwardSegment`'s post-interrupt `waitForPlayout()`. That wait races
 * the reply's own abort signal, but nothing on the ordinary interrupt path fires it — the
 * `replyAbortController.abort()` call lives past the segment loop the wait is blocking. The
 * speech scheduling loop then waits on that reply's generation future, so `_currentSpeech`
 * stays pinned on the interrupted handle and every later turn is queued but never authorized:
 * the agent goes silent for the rest of the session.
 *
 * The output below stands in for the class of sinks whose playback-finished event is not the
 * pipeline's to produce — remote avatar outputs (`DataStreamAudioOutput` and every avatar
 * plugin built on it) and any user-supplied `AudioOutput`. It honors the `AudioOutput`
 * contract: every segment it counts is eventually finished exactly once. It just cannot report
 * a segment the remote never began playing until the next turn's audio reaches it, which is
 * what closes the loop — the next turn cannot start until the wedged one lets go.
 *
 * The fix is `SpeechHandle`'s interruption watchdog (a port of python's `INTERRUPTION_TIMEOUT`
 * in `voice/speech_handle.py`), which cancels an interrupted speech's tasks — firing exactly
 * the abort signal those waits are already watching — and marks the handle done.
 */
import { AudioFrame } from '@livekit/rtc-node';
import { ReadableStream } from 'node:stream/web';
import { describe, expect, it } from 'vitest';
import { initializeLogger } from '../log.js';
import { Agent } from './agent.js';
import { AgentSession } from './agent_session.js';
import { AudioOutput } from './io.js';
import { FakeLLM } from './testing/fake_llm.js';

function frame(durationMs = 20, sampleRate = 24000): AudioFrame {
  const samples = Math.floor((sampleRate * durationMs) / 1000);
  return new AudioFrame(new Int16Array(samples), sampleRate, 1, samples);
}

type TtsControls = { push: (frame: AudioFrame) => void; close: () => void };

/** Hands each reply's TTS frame stream back to the test so interrupts can be timed exactly. */
class ScriptedTtsAgent extends Agent {
  readonly replies: TtsControls[] = [];

  constructor() {
    super({ instructions: 'test' });
  }

  async ttsNode(): Promise<ReadableStream<AudioFrame>> {
    let push!: (frame: AudioFrame) => void;
    let close!: () => void;
    const stream = new ReadableStream<AudioFrame>({
      start(controller) {
        push = (f) => {
          try {
            controller.enqueue(f);
          } catch {
            // stream already closed by a previous interrupt
          }
        };
        close = () => {
          try {
            controller.close();
          } catch {
            // already closed
          }
        };
      },
    });
    this.replies.push({ push, close });
    return stream;
  }
}

/**
 * A remote sink: frames are handed to a worker that plays them and reports back.
 *
 * `startPlayout` decides whether the worker gets far enough to start playing this turn's
 * audio. A segment it never started is not reported when the turn ends — the worker only
 * learns the turn is over when the next turn's audio arrives, and settles the old segment
 * then. Every counted segment is still finished exactly once.
 */
class RemoteWorkerAudioOutput extends AudioOutput {
  startPlayout = true;
  private unreportedSegments = 0;
  private playingSegment = false;

  constructor() {
    super(24000, undefined, { pause: false });
  }

  async captureFrame(f: AudioFrame): Promise<void> {
    while (this.unreportedSegments > 0) {
      this.unreportedSegments--;
      this.onPlaybackFinished({ playbackPosition: 0, interrupted: true });
    }
    await super.captureFrame(f);
    if (this.startPlayout && !this.playingSegment) {
      this.playingSegment = true;
      this.onPlaybackStarted(Date.now());
    }
  }

  flush(): void {
    const played = this.playingSegment;
    this.playingSegment = false;
    super.flush();
    if (played) {
      this.onPlaybackFinished({ playbackPosition: 0.02, interrupted: false });
    } else if (this.pendingPlayoutSegments > this.unreportedSegments) {
      this.unreportedSegments++;
    }
  }

  clearBuffer(): void {}
}

/** Surfaces a stall as a value, so a hang fails the test instead of hanging the suite. */
async function settleOrStall<T>(promise: Promise<T>, timeoutMs: number) {
  let timer: NodeJS.Timeout | undefined;
  const watchdog = new Promise<'did not settle'>((resolve) => {
    timer = setTimeout(() => resolve('did not settle'), timeoutMs);
  });
  try {
    return await Promise.race([promise, watchdog]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForReply(agent: ScriptedTtsAgent, index: number): Promise<TtsControls> {
  for (let i = 0; i < 400 && agent.replies.length <= index; i++) {
    await sleep(5);
  }
  const controls = agent.replies[index];
  if (!controls) throw new Error(`reply ${index} never reached the TTS node`);
  return controls;
}

describe('reply interrupted before playout start (#2065)', () => {
  initializeLogger({ pretty: false, level: 'silent' });

  it('keeps speaking after a reply is interrupted before its audio starts playing', async () => {
    const spoken: string[] = [];
    const agent = new ScriptedTtsAgent();
    const session = new AgentSession({
      llm: new FakeLLM([
        { input: 'one', content: 'first reply' },
        { input: 'two', content: 'second reply' },
      ]),
    });
    const audioOutput = new RemoteWorkerAudioOutput();
    session.output.audio = audioOutput;
    session.on('conversation_item_added', (ev) => {
      if (ev.item.role === 'assistant') spoken.push(ev.item.textContent);
    });

    await session.start({ agent });
    try {
      // The reply's audio reaches the sink but the remote never starts playing it, and the
      // user's next turn interrupts in that window.
      audioOutput.startPlayout = false;
      const first = session.generateReply({ userInput: 'one' });
      const firstTts = await waitForReply(agent, 0);
      await sleep(50);
      firstTts.push(frame());
      await sleep(50);
      session.interrupt();
      firstTts.close();
      await settleOrStall(first.waitForPlayout(), 10_000);

      // The turn the customer never hears: a later reply must still be spoken.
      audioOutput.startPlayout = true;
      const second = session.generateReply({ userInput: 'two' });
      const secondTts = await waitForReply(agent, 1);
      for (let i = 0; i < 5; i++) {
        secondTts.push(frame());
        await sleep(5);
      }
      secondTts.close();

      expect(await settleOrStall(second.waitForPlayout(), 15_000)).not.toBe('did not settle');
      expect(spoken).toContain('second reply');
    } finally {
      await settleOrStall(session.close(), 5000);
    }
  }, 60_000);
});
