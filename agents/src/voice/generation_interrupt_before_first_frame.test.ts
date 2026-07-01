// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression tests for livekit/agents-js#1909 (JS port of livekit/agents#5038/#5039).
 *
 * When the agent is in the "thinking" state and the user makes a brief sound
 * *before the first TTS audio frame has played*, `AgentActivity.onStartOfSpeech`
 * pauses the (not-yet-playing) speech. The TTS frames are still captured into the
 * paused output buffer and the forwarding task finishes — but playback has not
 * started yet, so `firstFrameFut` is still unresolved when the task ends.
 *
 * The bug: `forwardAudio` used to *reject* `firstFrameFut` (and remove its
 * PLAYBACK_STARTED listener) in its `finally` block whenever no frame had played.
 * So when the false interruption cleared and the output resumed, the buffered first
 * frame played but nothing was listening — `firstFrameFut` stayed rejected forever.
 * The reply task gates transcript preservation on
 * `firstFrameFut.done && !firstFrameFut.rejected`, so the resumed turn was dropped
 * from history even though audio reached the user.
 *
 * The fix moves the PLAYBACK_STARTED listener to `performAudioForwarding` (so it
 * outlives the forwarding task) and stops rejecting the future in `forwardAudio`;
 * the caller settles it after playout finishes/interrupts. A late first frame can
 * therefore still resolve the future and keep the turn.
 *
 * NOTE: in the JS `Future`, "cancel" is `reject` (it sets `rejected = true`), so a
 * literal transcription of #5039 would not have changed the `!rejected` gate — these
 * tests assert on `rejected`/`done` directly to lock in the corrected behavior.
 */
import { AudioFrame } from '@livekit/rtc-node';
import { ReadableStream } from 'stream/web';
import { describe, expect, it } from 'vitest';
import { initializeLogger } from '../log.js';
import type { _AudioOut } from './generation.js';
import { performAudioForwarding } from './generation.js';
import { AudioOutput } from './io.js';

function createSilentFrame(sampleRate = 24000, channels = 1, durationMs = 20): AudioFrame {
  const samplesPerChannel = Math.floor((sampleRate * durationMs) / 1000);
  const data = new Int16Array(samplesPerChannel * channels);
  return new AudioFrame(data, sampleRate, channels, samplesPerChannel);
}

/**
 * Mock output that models a real audio sink's pause semantics: while paused, frames
 * are buffered but PLAYBACK_STARTED is NOT emitted; it fires only once the first
 * frame actually plays (on the first un-paused capture, or when a paused buffer is
 * resumed). `clearBuffer` drops buffered frames (a real interruption).
 */
class PausableMockAudioOutput extends AudioOutput {
  capturedFrames: AudioFrame[] = [];
  clearBufferCalls = 0;
  private paused = false;
  private startedPlaying = false;

  constructor() {
    super(24000, undefined, { pause: true });
  }

  async captureFrame(frame: AudioFrame): Promise<void> {
    await super.captureFrame(frame);
    this.capturedFrames.push(frame);
    if (!this.paused) {
      this.maybeStartPlayback();
    }
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    const wasPaused = this.paused;
    this.paused = false;
    // On resume, a buffered (but never-played) first frame begins playing.
    if (wasPaused && this.capturedFrames.length > 0) {
      this.maybeStartPlayback();
    }
  }

  clearBuffer(): void {
    this.clearBufferCalls++;
    this.capturedFrames = [];
  }

  private maybeStartPlayback(): void {
    if (!this.startedPlaying) {
      this.startedPlaying = true;
      this.onPlaybackStarted(Date.now());
    }
  }
}

/**
 * Mirrors the gate used by the reply tasks in `agent_activity.ts` to decide whether
 * the synchronized transcript (i.e. the turn) is preserved after an interruption.
 */
function wouldPreserveTranscript(audioOut: _AudioOut): boolean {
  return audioOut.firstFrameFut.done && !audioOut.firstFrameFut.rejected;
}

describe('interruption before the first audio frame (#1909)', () => {
  initializeLogger({ pretty: false, level: 'silent' });

  it('resumes and plays a speech paused before its first frame (false interruption)', async () => {
    // A controlled stream so we can pause the output *after* forwardAudio has
    // started (and called its initial resume()) but before any frame is read.
    let enqueue!: (frame: AudioFrame) => void;
    let close!: () => void;
    const stream = new ReadableStream<AudioFrame>({
      start(controller) {
        enqueue = (frame) => controller.enqueue(frame);
        close = () => controller.close();
      },
    });

    const audioOutput = new PausableMockAudioOutput();
    const controller = new AbortController();
    const [task, audioOut] = performAudioForwarding(stream, audioOutput, controller);

    // User barges in during the thinking state, before the first frame has played.
    audioOutput.pause();

    // TTS frames arrive and are captured into the paused buffer; the forwarding
    // task then finishes (TTS stream closed) while playback has not started.
    enqueue(createSilentFrame());
    enqueue(createSilentFrame());
    close();
    await task.result;

    expect(audioOutput.capturedFrames.length).toBe(2);
    // The discriminating assertion: on `main`, forwardAudio's finally rejected the
    // future here, dropping the turn. The fix leaves it pending until playback.
    expect(audioOut.firstFrameFut.rejected).toBe(false);
    expect(audioOut.firstFrameFut.done).toBe(false);

    // The false interruption clears: the output resumes and the buffered first
    // frame finally plays.
    audioOutput.resume();
    const startedAt = await audioOut.firstFrameFut.await;

    expect(typeof startedAt).toBe('number');
    expect(audioOut.firstFrameFut.done).toBe(true);
    expect(audioOut.firstFrameFut.rejected).toBe(false);
    // The reply task would keep the (full) turn instead of blanking it.
    expect(wouldPreserveTranscript(audioOut)).toBe(true);
  });

  it('keeps the partial transcript on a genuine interruption after a resume', async () => {
    let enqueue!: (frame: AudioFrame) => void;
    let close!: () => void;
    const stream = new ReadableStream<AudioFrame>({
      start(controller) {
        enqueue = (frame) => controller.enqueue(frame);
        close = () => controller.close();
      },
    });

    const audioOutput = new PausableMockAudioOutput();
    const controller = new AbortController();
    const [task, audioOut] = performAudioForwarding(stream, audioOutput, controller);

    // Paused in the thinking state before the first frame; frames buffer.
    audioOutput.pause();
    enqueue(createSilentFrame());
    enqueue(createSilentFrame());
    close();
    await task.result;

    expect(audioOut.firstFrameFut.rejected).toBe(false);

    // The pause clears and playback starts (firstFrameFut resolves)...
    audioOutput.resume();
    await audioOut.firstFrameFut.await;

    // ...then the user genuinely interrupts mid-playback: the reply task clears the
    // buffer and evaluates its gate.
    audioOutput.clearBuffer();
    expect(audioOutput.clearBufferCalls).toBe(1);

    // The turn is NOT silently lost: a frame did play, so the gate preserves the
    // synchronized (partial) transcript. On `main` the future was already rejected
    // during the paused finish, so this gate would be false and the turn dropped.
    expect(wouldPreserveTranscript(audioOut)).toBe(true);

    // Caller-side cleanup (mirrors AgentActivity.settleFirstFrameFut) is a no-op
    // here because the future already resolved.
    expect(audioOut.firstFrameFut.done).toBe(true);
    expect(audioOut.firstFrameFut.rejected).toBe(false);
  });
});
