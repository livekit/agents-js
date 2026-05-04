// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Reusable fake STT for exercising the STT pipeline in tests without talking
 * to a real provider. Ported from the Python harness at
 * `livekit-agents/tests/fake_stt.py` so JS tests can achieve the same
 * coverage shape (scripted failures, mid-test behaviour flips, timed interim
 * + final transcript emission).
 */
import type { AudioFrame } from '@livekit/rtc-node';
import { asLanguageCode } from '../../language.js';
import type { APIConnectOptions } from '../../types.js';
import { AsyncIterableQueue, type AudioBuffer, delay } from '../../utils.js';
import {
  STT,
  type STTCapabilities,
  type SpeechEvent,
  SpeechEventType,
  SpeechStream,
} from '../stt.js';

/**
 * Describes a scheduled speech turn. `startTime`/`endTime`/`sttDelay` are in
 * milliseconds and keyed to the moment the first audio frame is pushed into
 * the stream — not wall-clock. `sttDelay` is the provider's transcription
 * lag; the stream emits an interim result halfway through and a final result
 * at `endTime + sttDelay`.
 *
 * Python uses seconds here — multiply Python fixtures by 1000 when porting.
 */
// Ref: python tests/fake_stt.py - 29-34 lines
export interface FakeUserSpeech {
  startTime: number;
  endTime: number;
  transcript: string;
  sttDelay: number;
}

/** Scale every timing field by `factor` — useful for speeding up tests. */
// Ref: python tests/fake_stt.py - 36-41 lines
export function speedUpFakeUserSpeech(speech: FakeUserSpeech, factor: number): FakeUserSpeech {
  return {
    ...speech,
    startTime: speech.startTime / factor,
    endTime: speech.endTime / factor,
    sttDelay: speech.sttDelay / factor,
  };
}

/** Marker posted to {@link FakeSTT.recognizeCh} each time `recognize()` runs. */
// Ref: python tests/fake_stt.py - 25-26 lines
export class RecognizeSentinel {}

export interface FakeSTTOptions {
  label?: string;
  fakeException?: Error | null;
  fakeTranscript?: string | null;
  fakeTimeoutMs?: number | null;
  fakeUserSpeeches?: FakeUserSpeech[] | null;
  fakeRequireAudio?: boolean;
  capabilities?: Partial<STTCapabilities>;
}

type UpdateOptions = Partial<
  Pick<FakeSTTOptions, 'fakeException' | 'fakeTranscript' | 'fakeTimeoutMs'>
>;

/**
 * Configurable stand-in for a real {@link STT}. Knobs mirror Python's
 * `FakeSTT`: inject exceptions, scripted transcripts, connection timeouts,
 * or a full sequence of {@link FakeUserSpeech} turns.
 *
 * Observability: every call to `recognize()` posts to {@link recognizeCh}
 * and every call to `stream()` posts the new stream to {@link streamCh}, so
 * tests can assert on attempt counts directly instead of inferring them.
 *
 * @example
 * ```ts
 * const primary = new FakeSTT({ fakeException: new APIConnectionError('down') });
 * const fallback = new FakeSTT({ fakeTranscript: 'hello world' });
 * const adapter = new FallbackAdapter({ sttInstances: [primary, fallback] });
 * const ev = await adapter.recognize(frame);
 * assert(ev.alternatives[0].text === 'hello world');
 * assert((await primary.recognizeCh.next()).value instanceof RecognizeSentinel);
 * ```
 */
// Ref: python tests/fake_stt.py - 44-147 lines
export class FakeSTT extends STT {
  label: string;

  private _fakeException: Error | null;
  private _fakeTranscript: string | null;
  private _fakeTimeoutMs: number | null;
  private _fakeUserSpeeches: FakeUserSpeech[] | null;
  private _fakeRequireAudio: boolean;

  private _recognizeCh = new AsyncIterableQueue<RecognizeSentinel>();
  private _streamCh = new AsyncIterableQueue<FakeRecognizeStream>();
  private _fakeUserSpeechesDone: Promise<void>;
  private _resolveFakeUserSpeechesDone!: () => void;

  constructor(opts: FakeSTTOptions = {}) {
    super({
      streaming: opts.capabilities?.streaming ?? true,
      interimResults: opts.capabilities?.interimResults ?? false,
      diarization: opts.capabilities?.diarization ?? false,
      alignedTranscript: opts.capabilities?.alignedTranscript ?? false,
    });
    this.label = opts.label ?? 'fake-stt';
    this._fakeException = opts.fakeException ?? null;
    this._fakeTranscript = opts.fakeTranscript ?? null;
    this._fakeTimeoutMs = opts.fakeTimeoutMs ?? null;
    this._fakeRequireAudio = opts.fakeRequireAudio ?? false;

    let speeches = opts.fakeUserSpeeches ?? null;
    if (speeches && speeches.length > 0) {
      speeches = [...speeches].sort((a, b) => a.startTime - b.startTime);
      for (let i = 0; i < speeches.length - 1; i++) {
        if (speeches[i]!.endTime > speeches[i + 1]!.startTime) {
          throw new Error('fake user speeches overlap');
        }
      }
    }
    this._fakeUserSpeeches = speeches;

    this._fakeUserSpeechesDone = new Promise<void>((resolve) => {
      this._resolveFakeUserSpeechesDone = resolve;
    });
  }

  /** Replace one or more fake knobs mid-test (e.g. flip from error to success). */
  // Ref: python tests/fake_stt.py - 74-88 lines
  updateOptions(opts: UpdateOptions): void {
    if ('fakeException' in opts) this._fakeException = opts.fakeException ?? null;
    if ('fakeTranscript' in opts) this._fakeTranscript = opts.fakeTranscript ?? null;
    if ('fakeTimeoutMs' in opts) this._fakeTimeoutMs = opts.fakeTimeoutMs ?? null;
  }

  /** Channel: one sentinel per `recognize()` invocation. */
  // Ref: python tests/fake_stt.py - 90-92 lines
  get recognizeCh(): AsyncIterableQueue<RecognizeSentinel> {
    return this._recognizeCh;
  }

  /** Channel: one stream instance per `stream()` invocation. */
  // Ref: python tests/fake_stt.py - 94-96 lines
  get streamCh(): AsyncIterableQueue<FakeRecognizeStream> {
    return this._streamCh;
  }

  // Ref: python tests/fake_stt.py - 98-100 lines
  get fakeUserSpeeches(): FakeUserSpeech[] | null {
    return this._fakeUserSpeeches;
  }

  /** Resolves once the scheduled `fake_user_speeches` have all been emitted. */
  // Ref: python tests/fake_stt.py - 102-104 lines
  get fakeUserSpeechesDone(): Promise<void> {
    return this._fakeUserSpeechesDone;
  }

  /** @internal Read-only state snapshot for the stream to consult. */
  get _state(): Readonly<{
    fakeException: Error | null;
    fakeTranscript: string | null;
    fakeTimeoutMs: number | null;
    fakeUserSpeeches: FakeUserSpeech[] | null;
    fakeRequireAudio: boolean;
  }> {
    return {
      fakeException: this._fakeException,
      fakeTranscript: this._fakeTranscript,
      fakeTimeoutMs: this._fakeTimeoutMs,
      fakeUserSpeeches: this._fakeUserSpeeches,
      fakeRequireAudio: this._fakeRequireAudio,
    };
  }

  /** @internal Called from the stream once it has finished the scheduled speeches. */
  _markFakeUserSpeechesDone(): void {
    this._resolveFakeUserSpeechesDone();
  }

  // Ref: python tests/fake_stt.py - 106-124 lines
  protected async _recognize(_frame: AudioBuffer): Promise<SpeechEvent> {
    if (this._fakeTimeoutMs !== null) {
      await delay(this._fakeTimeoutMs);
    }
    if (this._fakeException !== null) {
      throw this._fakeException;
    }
    return {
      type: SpeechEventType.FINAL_TRANSCRIPT,
      alternatives: [
        {
          text: this._fakeTranscript ?? '',
          language: asLanguageCode(''),
          startTime: 0,
          endTime: 0,
          confidence: 1,
        },
      ],
    };
  }

  // Ref: python tests/fake_stt.py - 126-134 lines
  override async recognize(frame: AudioBuffer, abortSignal?: AbortSignal): Promise<SpeechEvent> {
    this._recognizeCh.put(new RecognizeSentinel());
    return super.recognize(frame, abortSignal);
  }

  // Ref: python tests/fake_stt.py - 136-147 lines
  override stream(options?: { connOptions?: APIConnectOptions }): FakeRecognizeStream {
    const stream = new FakeRecognizeStream(this, options?.connOptions);
    this._streamCh.put(stream);
    return stream;
  }
}

/**
 * Stream returned by {@link FakeSTT.stream}. Exposes an `attempt` counter and
 * `sendFakeTranscript()` so tests can inject interim/final events at will.
 */
// Ref: python tests/fake_stt.py - 150-227 lines
export class FakeRecognizeStream extends SpeechStream {
  label: string;

  private _attempt = 0;
  private _fakeStt: FakeSTT;

  // Ref: python tests/fake_stt.py - 151-160 lines
  constructor(stt: FakeSTT, connOptions?: APIConnectOptions) {
    super(stt, undefined, connOptions);
    this._fakeStt = stt;
    this.label = `${stt.label}.stream`;
  }

  // Ref: python tests/fake_stt.py - 162-164 lines
  get attempt(): number {
    return this._attempt;
  }

  /** Push a synthetic INTERIM or FINAL event onto the output queue. */
  // Ref: python tests/fake_stt.py - 166-174 lines
  sendFakeTranscript(transcript: string, isFinal = true): void {
    this.queue.put({
      type: isFinal ? SpeechEventType.FINAL_TRANSCRIPT : SpeechEventType.INTERIM_TRANSCRIPT,
      alternatives: [
        {
          text: transcript,
          language: asLanguageCode(''),
          startTime: 0,
          endTime: 0,
          confidence: 1,
        },
      ],
    });
  }

  // Ref: python tests/fake_stt.py - 176-202 lines
  protected async run(): Promise<void> {
    this._attempt += 1;
    const state = this._fakeStt._state;

    if (state.fakeTimeoutMs !== null) {
      await delay(state.fakeTimeoutMs);
    }

    if (state.fakeRequireAudio) {
      // Emit a transcript only after we've both received audio frames and
      // seen a flush — matches the Python fake's shape for providers that
      // block on real audio.
      let gotAudio = false;
      for await (const data of this.input) {
        if (data === SpeechStream.FLUSH_SENTINEL) {
          if (gotAudio && state.fakeTranscript !== null) {
            this.sendFakeTranscript(state.fakeTranscript);
          }
          gotAudio = false;
        } else {
          gotAudio = true;
        }
      }
    } else {
      if (state.fakeTranscript !== null) {
        this.sendFakeTranscript(state.fakeTranscript);
      }
      await this.fakeUserSpeechTask();
      // Drain remaining input until EOF so the stream terminates cleanly.
      for await (const _ of this.input) {
        /* noop */
      }
    }

    if (state.fakeException !== null) {
      throw state.fakeException;
    }
  }

  // Ref: python tests/fake_stt.py - 204-227 lines
  private async fakeUserSpeechTask(): Promise<void> {
    const speeches = this._fakeStt._state.fakeUserSpeeches;
    if (!speeches || speeches.length === 0) return;

    // Anchor the clock to the first frame the caller pushes.
    const first = await this.input.next();
    if (first.done) return;

    // Elapsed time in milliseconds since the first pushed frame.
    const startHrt = process.hrtime.bigint();
    const elapsed = (): number => Number(process.hrtime.bigint() - startHrt) / 1e6;

    for (const speech of speeches) {
      const interimAt = speech.endTime + speech.sttDelay * 0.5;
      if (elapsed() < interimAt) await delay(interimAt - elapsed());
      const interim = speech.transcript.split(/\s+/).slice(0, 2).join(' ');
      this.sendFakeTranscript(interim, false);

      const finalAt = speech.endTime + speech.sttDelay;
      if (elapsed() < finalAt) await delay(finalAt - elapsed());
      this.sendFakeTranscript(speech.transcript, true);
    }

    this._fakeStt._markFakeUserSpeechesDone();
  }
}

/** Convenience: a zero-length audio frame suitable for `recognize()` calls. */
export function emptyAudioFrame(): AudioBuffer {
  // `recognize()` only reads the frame for its audio duration. Empty is
  // valid for callers that only care about the exception/transcript path.
  return [] as unknown as AudioBuffer;
}

export type { AudioFrame };
