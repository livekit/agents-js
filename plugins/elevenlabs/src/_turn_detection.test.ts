// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { VAD, VADEventType, VADStream } from '@livekit/agents';
import { AudioFrame } from '@livekit/rtc-node';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TurnDetection } from './_turn_detection.js';

const TIMEOUT = 1000;
// fast-check reports a seed, path, and shrunk event sequence on failure.
// Filter with -t, then set ELEVENLABS_FUZZ_SEED and ELEVENLABS_FUZZ_PATH to replay one property.
const parameters = {
  seed: Number(process.env.ELEVENLABS_FUZZ_SEED ?? 3029),
  numRuns: Number(process.env.ELEVENLABS_FUZZ_RUNS ?? 200),
  ...(process.env.ELEVENLABS_FUZZ_PATH && { path: process.env.ELEVENLABS_FUZZ_PATH }),
};

class EventVADStream extends VADStream {
  closeCalls = 0;
  failInput = false;

  emit(speaking: boolean): void {
    this.sendVADEvent({
      type: speaking ? VADEventType.START_OF_SPEECH : VADEventType.END_OF_SPEECH,
      samplesIndex: 0,
      timestamp: Date.now(),
      speechDuration: 0,
      silenceDuration: 0,
      frames: [],
      probability: Number(speaking),
      inferenceDuration: 0,
      speaking,
      rawAccumulatedSilence: 0,
      rawAccumulatedSpeech: 0,
    });
  }

  override pushFrame(_frame: AudioFrame): void {
    if (this.failInput) throw new Error('VAD input failed');
  }

  override close(): void {
    this.closeCalls += 1;
    super.close();
  }
}

class EventVAD extends VAD {
  label = 'test.EventVAD';
  streams: EventVADStream[] = [];

  constructor() {
    super({ updateInterval: 100 });
  }

  stream(): EventVADStream {
    const stream = new EventVADStream(this);
    this.streams.push(stream);
    return stream;
  }
}

/** Feeds VAD stream events and audio frames into turn detection. */
class Harness {
  readonly vad = new EventVAD();
  readonly ends: number[] = [];
  readonly detector: TurnDetection;
  readonly finalMessageType: string;
  connected = false;
  available = false;
  speaking = false;
  copies: string[] = [];
  private vadTask?: Promise<void>;

  constructor(timestamps: boolean) {
    this.finalMessageType = timestamps
      ? 'committed_transcript_with_timestamps'
      : 'committed_transcript';
    this.detector = new TurnDetection({
      options: {
        modelId: 'scribe_v3_live',
        commitStrategy: 'turn_prediction',
        serverVad: { vadSilenceThresholdSecs: 0.5 },
      },
      vad: this.vad,
      onEndOfSpeech: () => this.ends.push(Date.now()),
    });
  }

  async start(): Promise<void> {
    await this.close();
    await this.detector.start();
    this.connected = this.available = true;
    this.speaking = false;
    this.copies = [];
    this.vadTask = this.detector.runVad();
  }

  async close(): Promise<void> {
    await this.detector.close();
    await this.vadTask;
    this.connected = this.available = false;
  }

  async setSpeaking(speaking: boolean): Promise<void> {
    if (!this.available || this.speaking === speaking) return;
    this.vad.streams.at(-1)!.emit(speaking);
    this.speaking = speaking;
    await vi.advanceTimersByTimeAsync(0);
  }

  async frame(durationInS: number): Promise<void> {
    await this.detector.pushFrame(
      new AudioFrame(new Int16Array(durationInS * 1000), 1000, 1, durationInS * 1000),
    );
  }

  async failVad(): Promise<void> {
    this.vad.streams.at(-1)!.failInput = true;
    await this.frame(0.1);
    this.available = false;
    this.speaking = false;
  }

  commit(text: string): boolean {
    if (this.finalMessageType !== 'committed_transcript') this.copies.push(text);
    return this.message('committed_transcript', text);
  }

  timestampCopy(): boolean | undefined {
    const text = this.copies.shift();
    if (text !== undefined) return this.message('committed_transcript_with_timestamps', text);
  }

  private message(messageType: string, text: string): boolean {
    const forced = this.detector.onCommittedTranscript(
      { message_type: messageType, text },
      this.finalMessageType,
    );
    // Match the owning SpeechStream's selected-final boundary handling.
    if (messageType === this.finalMessageType && !forced) this.detector.endSpeech();
    return forced;
  }
}

type Action =
  | { type: 'partial'; text: string; probability: number | undefined }
  | { type: 'vad'; speaking: boolean }
  | { type: 'advance'; ms: number }
  | { type: 'commit'; text: string }
  | { type: 'reconnect' | 'close' | 'failVad' | 'timestampCopy' | 'clientCommit' }
  | { type: 'audio'; durationInS: number };

const partial = fc.record({
  type: fc.constant('partial' as const),
  text: fc.constantFrom('', 'hello', 'hello there', 'yes'),
  probability: fc.constantFrom(undefined, 0, 0.5, 0.89, 0.9, 1),
});
const vad = fc.record({ type: fc.constant('vad' as const), speaking: fc.boolean() });
const advance = fc.record({
  type: fc.constant('advance' as const),
  ms: fc.oneof(fc.constantFrom(0, 1, TIMEOUT - 1, TIMEOUT, TIMEOUT + 1), fc.nat(3000)),
});
const commit = fc.record({
  type: fc.constant('commit' as const),
  text: fc.constantFrom('', 'hello', 'yes'),
});
const ordinaryAction: fc.Arbitrary<Action> = fc.oneof(
  partial,
  partial,
  vad,
  advance,
  advance,
  commit,
  fc.constantFrom({ type: 'reconnect' }, { type: 'close' }, { type: 'failVad' }),
);
const stressAction: fc.Arbitrary<Action> = fc.oneof(
  ordinaryAction,
  fc.constantFrom({ type: 'timestampCopy' }, { type: 'clientCommit' }),
  fc.record({
    type: fc.constant('audio' as const),
    durationInS: fc.constantFrom(0.1, 1, 33.9, 34, 35.3, 38, 38.1),
  }),
);

async function execute(real: Harness, action: Action): Promise<void> {
  if (action.type === 'reconnect') return real.start();
  if (action.type === 'advance') {
    await vi.advanceTimersByTimeAsync(action.ms);
    return;
  }
  if (action.type === 'close') return real.close();
  if (!real.connected) return;
  switch (action.type) {
    case 'partial':
      real.detector.onPartialTranscript(action.probability, action.text);
      break;
    case 'vad':
      await real.setSpeaking(action.speaking);
      break;
    case 'commit':
      real.commit(action.text);
      break;
    case 'timestampCopy':
      real.timestampCopy();
      break;
    case 'clientCommit':
      real.detector.onCommitRequested();
      break;
    case 'audio':
      await real.frame(action.durationInS);
      break;
    case 'failVad':
      if (real.available) await real.failVad();
      break;
  }
}

// A three-state oracle specifies partial timing. Forced commits have separate temporal properties.
type Phase = 'idle' | 'awaitingSilence' | { deadline: number };
interface Model {
  phase: Phase;
  connected: boolean;
  available: boolean;
  speaking: boolean;
  lastText: string;
  now: number;
  ends: number[];
}

class Command implements fc.AsyncCommand<Model, Harness> {
  constructor(readonly action: Action) {}

  check(): boolean {
    return true;
  }

  async run(model: Model, real: Harness): Promise<void> {
    const action = this.action;
    if (action.type === 'advance') {
      const target = model.now + action.ms;
      if (typeof model.phase === 'object' && model.phase.deadline <= target) {
        model.ends.push(model.phase.deadline);
        model.phase = 'idle';
      }
      model.now = target;
    } else if (action.type === 'close' || action.type === 'reconnect') {
      if (model.available && model.phase !== 'idle') model.ends.push(model.now);
      model.phase = 'idle';
      model.connected = model.available = action.type === 'reconnect';
      if (action.type === 'reconnect') {
        model.speaking = false;
        model.lastText = '';
      }
    } else if (model.connected) {
      if (action.type === 'partial' && action.text && action.text !== model.lastText) {
        model.lastText = action.text;
        if (model.available && model.phase === 'idle') {
          model.phase = model.speaking ? 'awaitingSilence' : { deadline: model.now + TIMEOUT };
        }
      } else if (action.type === 'vad' && model.available && action.speaking !== model.speaking) {
        model.speaking = action.speaking;
        if (model.phase !== 'idle') {
          model.phase = model.speaking ? 'awaitingSilence' : { deadline: model.now + TIMEOUT };
        }
      } else if (action.type === 'commit') {
        model.lastText = '';
        model.phase = 'idle';
        model.ends.push(model.now);
      } else if (action.type === 'failVad') {
        model.available = false;
        model.speaking = false;
        model.phase = 'idle';
      }
    }
    await execute(real, action);
    if (action.type === 'commit' && real.connected) real.timestampCopy();
    expect(real.ends).toEqual(model.ends);
  }

  toString(): string {
    return JSON.stringify(this.action);
  }
}

async function withHarness(
  timestamps: boolean,
  run: (real: Harness) => Promise<void>,
): Promise<void> {
  vi.setSystemTime(0);
  const real = new Harness(timestamps);
  await real.start();
  try {
    await run(real);
  } finally {
    await real.close();
    expect(real.vad.streams.every((stream) => stream.closeCalls === 1)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  }
}

describe('TurnDetection randomized event sequences', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('preserves the continuation deadline across a delayed forced timestamp copy', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.nat(2 * TIMEOUT),
        fc.nat(TIMEOUT - 1),
        fc.boolean(),
        async (continuationDelay, copyDelay, stillSpeaking) => {
          await withHarness(true, async (real) => {
            await real.setSpeaking(true);
            await real.frame(35.3);
            real.detector.onPartialTranscript(0.5, 'forced segment');
            real.commit('forced segment');
            await vi.advanceTimersByTimeAsync(continuationDelay);
            real.detector.onPartialTranscript(0.5, 'continuation');
            await real.setSpeaking(stillSpeaking);
            let silenceAt = Date.now();
            await vi.advanceTimersByTimeAsync(copyDelay);
            expect(real.timestampCopy()).toBe(true);
            if (stillSpeaking) {
              await vi.advanceTimersByTimeAsync(2 * TIMEOUT);
              expect(real.ends).toEqual([]);
              await real.setSpeaking(false);
              silenceAt = Date.now();
            }
            await vi.advanceTimersByTimeAsync(silenceAt + TIMEOUT - Date.now() - 1);
            real.detector.onPartialTranscript(1, 'continuation');
            expect(real.ends).toEqual([]);
            await vi.advanceTimersByTimeAsync(1);
            expect(real.ends).toEqual([silenceAt + TIMEOUT]);
            await vi.advanceTimersByTimeAsync(2 * TIMEOUT);
            expect(real.ends).toEqual([silenceAt + TIMEOUT]);
          });
        },
      ),
      parameters,
    );
  }, 30000);

  it.each([false, true])(
    'matches the partial FSM with timestamps=%s',
    async (timestamps) => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(ordinaryAction, { maxLength: 80, size: 'large' }),
          async (actions) => {
            await withHarness(timestamps, async (real) => {
              const model: Model = {
                phase: 'idle',
                connected: true,
                available: true,
                speaking: false,
                lastText: '',
                now: 0,
                ends: [],
              };
              await fc.asyncModelRun(
                () => ({ model, real }),
                actions.map((action) => new Command(action)),
              );
            });
          },
        ),
        parameters,
      );
    },
    30000,
  );

  it.each([false, true])(
    'preserves liveness and cleanup after mixed history with timestamps=%s',
    async (timestamps) => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(stressAction, { maxLength: 80, size: 'large' }),
          async (actions) => {
            await withHarness(timestamps, async (real) => {
              // Enter the forced-commit path through real audio accounting and a VAD event.
              await real.setSpeaking(true);
              await real.frame(35.3);
              real.detector.onPartialTranscript(0.5, 'forced segment');
              expect(real.commit('forced segment')).toBe(!timestamps);
              for (const action of actions) await execute(real, action);
              if (!real.connected || !real.available) await real.start();

              await real.setSpeaking(true);
              real.detector.onPartialTranscript(0.5, 'unique continuation probe');
              const before = [...real.ends];
              await vi.advanceTimersByTimeAsync(2 * TIMEOUT);
              expect(real.ends).toEqual(before);
              await real.setSpeaking(false);
              const silenceAt = Date.now();
              await vi.advanceTimersByTimeAsync(TIMEOUT - 1);
              real.detector.onPartialTranscript(1, 'unique continuation probe');
              expect(real.ends).toEqual(before);
              await vi.advanceTimersByTimeAsync(1);
              expect(real.ends).toEqual([...before, silenceAt + TIMEOUT]);
              await vi.advanceTimersByTimeAsync(2 * TIMEOUT);
              expect(real.ends).toEqual([...before, silenceAt + TIMEOUT]);

              await real.close();
              const closed = [...real.ends];
              await vi.advanceTimersByTimeAsync(10 * TIMEOUT);
              expect(real.ends).toEqual(closed);
              await real.start();
              await vi.advanceTimersByTimeAsync(10 * TIMEOUT);
              expect(real.ends).toEqual(closed);
            });
          },
        ),
        parameters,
      );
    },
    30000,
  );
});
