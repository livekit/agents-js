// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioFrame, type Room, TrackPublishOptions, TrackSource } from '@livekit/rtc-node';
import { ReadableStream } from 'node:stream/web';
import { describe, expect, it } from 'vitest';
import { initializeLogger } from '../log.js';
import { Future } from '../utils.js';
import { VADEventType } from '../vad.js';
import { Agent } from './agent.js';
import { AgentSession } from './agent_session.js';
import { AgentSessionEventTypes } from './events.js';
import { ParticipantAudioOutput } from './room_io/_output.js';
import { FakeLLM } from './testing/fake_llm.js';

const SAMPLE_RATE = 24000;
const FRAME_MS = 20;
const FRAMES_PER_REPLY = 10;
const FALSE_INTERRUPTION_TIMEOUT = 300;

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

/**
 * Emits every frame of the reply, then holds the TTS stream open until the test closes it, so
 * the reply can be paused after its last frame is already captured and completed afterwards.
 */
class HeldTailAgent extends Agent {
  produced = 0;
  onFrame?: (produced: number) => void;
  readonly tailReleased = new Future<void>();

  constructor() {
    super({ instructions: 'test' });
  }

  async ttsNode(): Promise<ReadableStream<AudioFrame>> {
    let emitted = 0;
    return new ReadableStream<AudioFrame>({
      pull: async (controller) => {
        if (emitted >= FRAMES_PER_REPLY) {
          await this.tailReleased.await;
          controller.close();
          return;
        }
        emitted++;
        controller.enqueue(frame());
        this.produced++;
        this.onFrame?.(this.produced);
      },
    });
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('a paused speech that completes', () => {
  initializeLogger({ pretty: false, level: 'silent' });

  it('releases the pause it was holding once its generation is done', async () => {
    const session = new AgentSession({
      llm: new FakeLLM([{ input: 'one', content: 'first reply' }]),
      aecWarmupDuration: null,
      turnHandling: { interruption: { falseInterruptionTimeout: FALSE_INTERRUPTION_TIMEOUT } },
    });

    const out = new TestParticipantAudioOutput();
    session.output.audio = out;

    let delivered = 0;
    const source = (
      out as unknown as { audioSource: { captureFrame: (f: AudioFrame) => Promise<void> } }
    ).audioSource;
    const captureFrame = source.captureFrame.bind(source);
    source.captureFrame = async (f: AudioFrame) => {
      delivered++;
      return captureFrame(f);
    };

    const falseInterruptions: boolean[] = [];
    session.on(AgentSessionEventTypes.AgentFalseInterruption, (ev) =>
      falseInterruptions.push(ev.resumed),
    );

    const agent = new HeldTailAgent();
    await session.start({ agent });

    const activity = session._activity!;
    const sink = out as unknown as { playbackEnabledFuture: { done: boolean } };
    const paused = () => !sink.playbackEnabledFuture.done;
    const pausedSpeech = () =>
      (activity as unknown as { pausedSpeech?: { handle: { id: string } } }).pausedSpeech;

    try {
      // The agent finishes its sentence while the user talks over the tail: every frame is
      // already on the wire when the user's audio activity pauses the output, so the reply
      // drains to a clean, uninterrupted finish while still holding the pause.
      const reply = session.generateReply({ userInput: 'one' });
      for (let i = 0; i < 400 && delivered < FRAMES_PER_REPLY; i++) await sleep(5);
      expect(delivered).toBe(FRAMES_PER_REPLY);

      activity.onStartOfSpeech(vadEvent(VADEventType.START_OF_SPEECH));
      activity.onVADInferenceDone(vadEvent(VADEventType.INFERENCE_DONE, 600));
      expect(paused()).toBe(true);
      expect(pausedSpeech()?.handle.id).toBe(reply.id);

      agent.tailReleased.resolve();
      await reply.waitForPlayout();
      await sleep(50);

      // The speech the pause was taken out for is over. Nothing can resume it any more, so the
      // pause must be released here — otherwise it outlives its owner and the next thing that
      // reads it acts on a speech that is already gone.
      expect(reply.done()).toBe(true);
      expect(pausedSpeech()).toBeUndefined();
      expect(paused()).toBe(false);

      // The user stops talking. With the record gone this is a no-op; with a stale one it arms
      // a resume timer for the finished reply and reports a false interruption against it.
      activity.onEndOfSpeech(vadEvent(VADEventType.END_OF_SPEECH, 0, 100));
      await sleep(FALSE_INTERRUPTION_TIMEOUT + 200);

      expect(falseInterruptions).toEqual([]);
    } finally {
      agent.tailReleased.resolve();
      await session.close();
      await out.close();
    }
  }, 30000);
});
