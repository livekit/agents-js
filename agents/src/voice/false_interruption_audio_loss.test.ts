// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioFrame, type Room, TrackPublishOptions, TrackSource } from '@livekit/rtc-node';
import { ReadableStream } from 'node:stream/web';
import { describe, expect, it } from 'vitest';
import { initializeLogger } from '../log.js';
import { VADEventType } from '../vad.js';
import { Agent } from './agent.js';
import { AgentSession } from './agent_session.js';
import { AgentSessionEventTypes } from './events.js';
import { ParticipantAudioOutput } from './room_io/_output.js';
import { FakeLLM } from './testing/fake_llm.js';

const SAMPLE_RATE = 24000;
const FRAME_MS = 20;
const FRAMES_PER_REPLY = 20;
const FALSE_INTERRUPTION_TIMEOUT = 400;

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

/** Emits `FRAMES_PER_REPLY` frames spaced out in time so a turn can be interleaved with VAD events. */
class FrameAgent extends Agent {
  produced = 0;
  onFrame?: (produced: number) => void;

  constructor() {
    super({ instructions: 'test' });
  }

  async ttsNode(): Promise<ReadableStream<AudioFrame>> {
    let emitted = 0;
    const emit = () => {
      this.produced++;
      this.onFrame?.(this.produced);
    };
    return new ReadableStream<AudioFrame>({
      pull: async (controller) => {
        if (emitted >= FRAMES_PER_REPLY) {
          controller.close();
          return;
        }
        if (emitted > 0) await new Promise((resolve) => setTimeout(resolve, 15));
        emitted++;
        controller.enqueue(frame());
        emit();
      },
    });
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function makeHarness() {
  const session = new AgentSession({
    llm: new FakeLLM([
      { input: 'one', content: 'first reply' },
      { input: 'two', content: 'second reply' },
    ]),
    aecWarmupDuration: null,
    turnHandling: { interruption: { falseInterruptionTimeout: FALSE_INTERRUPTION_TIMEOUT } },
  });

  const out = new TestParticipantAudioOutput();
  session.output.audio = out;

  // Frame accounting at the boundary the bug lives on: how many frames actually reached
  // the LiveKit AudioSource, i.e. the wire.
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
    out,
    agent,
    falseInterruptions,
    delivered: () => delivered,
    paused: () => !gate.done,
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
 * One reply that a backchannel pauses mid-flight and the false-interruption timer resumes.
 * Every frame the TTS produced must reach the wire: the ones captured while the output was
 * paused are held at the gate and pushed on resume.
 */
async function falseInterruptedReply(h: Harness, userInput: string) {
  const producedBefore = h.agent.produced;
  const deliveredBefore = h.delivered();

  const handle = h.session.generateReply({ userInput });
  await h.waitForProduced(producedBefore + 3);

  h.activity().onStartOfSpeech(vadEvent(VADEventType.START_OF_SPEECH));
  h.activity().onVADInferenceDone(vadEvent(VADEventType.INFERENCE_DONE, 600));
  const pausedMidReply = h.paused();
  // The user only said "mm-hmm": no final transcript follows, so the false-interruption
  // timer is what resumes playback.
  h.activity().onEndOfSpeech(vadEvent(VADEventType.END_OF_SPEECH, 0, 100));

  await handle.waitForPlayout();
  await sleep(FALSE_INTERRUPTION_TIMEOUT + 300);

  return {
    pausedMidReply,
    produced: h.agent.produced - producedBefore,
    delivered: h.delivered() - deliveredBefore,
  };
}

describe('false interruption after a previous interruption', () => {
  initializeLogger({ pretty: false, level: 'silent' });

  it('delivers the whole reply when nothing was interrupted before', async () => {
    const h = await makeHarness();
    try {
      const reply = await falseInterruptedReply(h, 'one');

      expect(reply.pausedMidReply).toBe(true);
      expect(reply.produced).toBe(FRAMES_PER_REPLY);
      expect(reply.delivered).toBe(reply.produced);
      expect(h.falseInterruptions).toEqual([true]);
    } finally {
      await h.close();
    }
  }, 30000);

  it('delivers the whole reply when the previous turn ended in a barge-in', async () => {
    const h = await makeHarness();
    try {
      // A genuine barge-in: VAD pauses the output, the final transcript confirms the
      // interruption, and the reply task calls clearBuffer() on the way out. That leaves
      // interruptedFuture resolved, and nothing resets it until the *next* segment's flush —
      // which only happens after that segment's frames have all been captured.
      const bargedInto = h.session.generateReply({ userInput: 'one' });
      await h.waitForProduced(3);
      h.activity().onStartOfSpeech(vadEvent(VADEventType.START_OF_SPEECH));
      h.activity().onVADInferenceDone(vadEvent(VADEventType.INFERENCE_DONE, 600));
      h.activity().onFinalTranscript(sttFinal('stop please'), false);
      await bargedInto.waitForPlayout();
      await sleep(150);

      // An ordinary false interruption on the next reply. Every frame captured during the
      // pause used to bail at the gate on the stale signal, losing the rest of the reply
      // while the session still recorded it as fully spoken.
      const reply = await falseInterruptedReply(h, 'two');

      expect(reply.pausedMidReply).toBe(true);
      expect(reply.produced).toBe(FRAMES_PER_REPLY);
      expect(reply.delivered).toBe(reply.produced);
      expect(h.falseInterruptions).toEqual([true]);
    } finally {
      await h.close();
    }
  }, 30000);

  it('delivers the whole reply when a paused reply completed and was then cancelled', async () => {
    const h = await makeHarness();
    try {
      // The agent finishes its sentence while the user talks over the tail: all frames are
      // captured, then the output is paused and the segment drains to a clean finish.
      const completed = h.session.generateReply({ userInput: 'one' });
      await h.waitForProduced(FRAMES_PER_REPLY);
      for (let i = 0; i < 200 && h.delivered() < FRAMES_PER_REPLY; i++) await sleep(5);
      await sleep(10);
      h.activity().onStartOfSpeech(vadEvent(VADEventType.START_OF_SPEECH));
      h.activity().onVADInferenceDone(vadEvent(VADEventType.INFERENCE_DONE, 600));
      await completed.waitForPlayout();
      await sleep(100);
      expect(h.delivered()).toBe(FRAMES_PER_REPLY);

      // The user's transcript finalizes and cancelSpeechPause un-gates the output.
      h.activity().onFinalTranscript(sttFinal('okay thanks'), false);
      await sleep(150);

      const reply = await falseInterruptedReply(h, 'two');

      expect(reply.pausedMidReply).toBe(true);
      expect(reply.produced).toBe(FRAMES_PER_REPLY);
      expect(reply.delivered).toBe(reply.produced);
    } finally {
      await h.close();
    }
  }, 30000);
});
