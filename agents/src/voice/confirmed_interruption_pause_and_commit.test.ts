// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioFrame, type Room, TrackPublishOptions, TrackSource } from '@livekit/rtc-node';
import { ReadableStream } from 'node:stream/web';
import { describe, expect, it } from 'vitest';
import type { OverlappingSpeechEvent } from '../inference/interruption/types.js';
import { initializeLogger } from '../log.js';
import { VADEventType } from '../vad.js';
import { Agent } from './agent.js';
import { AgentSession } from './agent_session.js';
import { AgentSessionEventTypes } from './events.js';
import { ParticipantAudioOutput } from './room_io/_output.js';
import { FakeLLM } from './testing/fake_llm.js';

const SAMPLE_RATE = 24000;
const FRAME_MS = 20;
const FRAMES_PER_REPLY = 40;
const FALSE_INTERRUPTION_TIMEOUT = 400;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function frame(): AudioFrame {
  const samples = (SAMPLE_RATE * FRAME_MS) / 1000;
  return new AudioFrame(new Int16Array(samples), SAMPLE_RATE, 1, samples);
}

function vadEvent(type: VADEventType, speechDuration = 0, silenceDuration = 0) {
  return {
    type,
    samplesIndex: 0,
    timestamp: Date.now(),
    speechDuration,
    silenceDuration,
    frames: [],
    probability: 1,
    inferenceDuration: 0,
    speaking: type === VADEventType.START_OF_SPEECH,
    rawAccumulatedSilence: 0,
    rawAccumulatedSpeech: 0,
  } as never;
}

function sttFinal(text: string) {
  return {
    type: 'final_transcript',
    alternatives: [{ text, language: 'en', startTime: 0, endTime: 0, confidence: 1 }],
  } as never;
}

/** The verdict shape `AudioRecognition` forwards on `bargein_detected`. */
function bargeInVerdict(overlapStartedAt: number): OverlappingSpeechEvent {
  return {
    type: 'overlapping_speech',
    detectedAt: Date.now(),
    isInterruption: true,
    overlapStartedAt,
    totalDurationInS: 0.1,
    predictionDurationInS: 0.05,
    detectionDelayInS: 0.2,
    probability: 0.99,
    numRequests: 1,
  };
}

/** The real ParticipantAudioOutput; only track publishing is skipped (no LiveKit server here). */
class TestParticipantAudioOutput extends ParticipantAudioOutput {
  constructor() {
    super({} as Room, {
      sampleRate: SAMPLE_RATE,
      numChannels: 1,
      trackPublishOptions: new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }),
      queueSizeMs: 100_000,
    });
    (this as unknown as { startedFuture: { resolve: () => void } }).startedFuture.resolve();
  }

  override async start(): Promise<void> {}
}

/** Emits frames spaced out in time so a barge-in can land mid-reply. */
class FrameAgent extends Agent {
  produced = 0;
  onFrame?: (produced: number) => void;

  constructor() {
    super({ instructions: 'test' });
  }

  async ttsNode(): Promise<ReadableStream<AudioFrame>> {
    let emitted = 0;
    return new ReadableStream<AudioFrame>({
      pull: async (controller) => {
        if (emitted >= FRAMES_PER_REPLY) {
          controller.close();
          return;
        }
        if (emitted > 0) await sleep(15);
        emitted++;
        controller.enqueue(frame());
        this.produced++;
        this.onFrame?.(this.produced);
      },
    });
  }
}

async function makeHarness() {
  const session = new AgentSession({
    llm: new FakeLLM([{ input: 'one', content: 'first reply' }]),
    aecWarmupDuration: null,
    turnHandling: { interruption: { falseInterruptionTimeout: FALSE_INTERRUPTION_TIMEOUT } },
  });

  const out = new TestParticipantAudioOutput();
  session.output.audio = out;

  // Frame accounting at the boundary that matters: how many frames actually reached the
  // LiveKit AudioSource, i.e. the wire.
  const source = (
    out as unknown as { audioSource: { captureFrame: (f: AudioFrame) => Promise<void> } }
  ).audioSource;
  const captureFrame = source.captureFrame.bind(source);
  let delivered = 0;
  source.captureFrame = async (f: AudioFrame) => {
    delivered++;
    return captureFrame(f);
  };

  const falseInterruptions: boolean[] = [];
  session.on(AgentSessionEventTypes.AgentFalseInterruption, (ev) =>
    falseInterruptions.push(ev.resumed),
  );

  const agent = new FrameAgent();
  await session.start({ agent });

  const gate = out as unknown as { playbackEnabledFuture: { done: boolean } };

  const waitForProduced = (n: number) =>
    new Promise<void>((resolve) => {
      agent.onFrame = (produced) => {
        if (produced >= n) resolve();
      };
    });

  return {
    session,
    agent,
    falseInterruptions,
    delivered: () => delivered,
    paused: () => !gate.playbackEnabledFuture.done,
    waitForProduced,
    activity: () => session._activity!,
    async close() {
      await session.close();
      await out.close();
    },
  };
}

type Harness = Awaited<ReturnType<typeof makeHarness>>;

/**
 * Drives a reply up to the moment the adaptive interruption model rules the overlap a genuine
 * barge-in, then lets the user fall silent so the false-interruption timer is armed.
 *
 * Returns the frame count at the AudioSource taken just before the verdict, so callers can
 * measure what reaches the wire after it.
 */
async function bargeInMidReply(h: Harness) {
  const handle = h.session.generateReply({ userInput: 'one' });
  await h.waitForProduced(3);

  // The user starts talking over the agent: VAD parks the reply at the pause gate.
  const overlapStartedAt = Date.now();
  h.activity().onStartOfSpeech(vadEvent(VADEventType.START_OF_SPEECH));
  h.activity().onVADInferenceDone(vadEvent(VADEventType.INFERENCE_DONE, 600));
  expect(h.paused()).toBe(true);

  // Let the TTS keep producing so frames are genuinely parked at the gate when the verdict
  // lands — those parked frames are the ones that can escape.
  await sleep(60);

  const deliveredBeforeVerdict = h.delivered();
  h.activity().onInterruption(bargeInVerdict(overlapStartedAt));
  // The user stops talking, which is what arms the false-interruption timer.
  h.activity().onEndOfSpeech(vadEvent(VADEventType.END_OF_SPEECH, 600, 200));

  return { handle, deliveredBeforeVerdict };
}

describe('confirmed barge-in: pause, then commit on the transcript', () => {
  initializeLogger({ pretty: false, level: 'silent' });

  /**
   * Parity with Python's `AgentActivity.on_interruption` (`agent_activity.py`), which does
   * restore → interrupt-by-audio-activity → `_on_end_of_agent_speech` and stops. The model's
   * verdict alone only *pauses* the reply; committing the user's turn needs an STT final
   * transcript. When none arrives within `falseInterruptionTimeout`, the false-interruption
   * timer puts the speech back rather than leaving the user in dead air, and the session
   * reports that with `agent_false_interruption(resumed: true)`.
   */
  it('resumes the paused reply when no transcript follows the verdict', async () => {
    const h = await makeHarness();
    try {
      const { handle, deliveredBeforeVerdict } = await bargeInMidReply(h);

      await sleep(FALSE_INTERRUPTION_TIMEOUT + 600);
      await handle.waitForPlayout();

      // The verdict did not commit the turn, so the reply resumes where it stopped.
      expect(handle.interrupted).toBe(false);
      expect(h.falseInterruptions).toEqual([true]);
      expect(h.delivered() - deliveredBeforeVerdict).toBeGreaterThan(0);
      expect(h.delivered()).toBe(FRAMES_PER_REPLY);
    } finally {
      await h.close();
    }
  }, 30000);

  /**
   * The other half of the same flow, and the one the sink ordering in `cancelSpeechPause()`
   * exists for. The final transcript arrives, so `onFinalTranscript` commits the interruption
   * through `cancelSpeechPause()`, which un-gates the output so the *next* speech can be
   * admitted. Frames of the reply just interrupted are still parked at that gate; unless the
   * interruption is signalled to the sink first, they are released before the interrupted
   * reply task reaches its own `clearBuffer()` and audio the user has already barged in over
   * reaches the wire.
   *
   * Measured at the AudioSource boundary, not by asserting a call order.
   */
  it('delivers no further audio once the final transcript commits the barge-in', async () => {
    const h = await makeHarness();
    try {
      const { handle, deliveredBeforeVerdict } = await bargeInMidReply(h);

      // STT finalizes what the user said, well inside the false-interruption timeout.
      h.activity().onFinalTranscript(sttFinal('stop please'), false);

      await handle.waitForPlayout();
      // Well past the timeout: nothing may resume the speech either.
      await sleep(FALSE_INTERRUPTION_TIMEOUT + 300);

      expect(h.delivered() - deliveredBeforeVerdict).toBe(0);
      expect(handle.interrupted).toBe(true);
      expect(h.falseInterruptions).toEqual([]);
      // The reply was cut short: this is a barge-in, not a completed turn.
      expect(h.delivered()).toBeLessThan(FRAMES_PER_REPLY);
    } finally {
      await h.close();
    }
  }, 30000);
});
