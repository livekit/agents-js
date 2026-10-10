// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioFrame } from '@livekit/rtc-node';
import { AudioByteStream } from '../audio.js';
import { AudioStreamDecoder, isRawPcm } from '../codecs/decoder.js';
import { log } from '../log.js';
import { AsyncIterableQueue, mergeFrames, toError } from '../utils.js';
import type { TimedString } from '../voice/io.js';
import type { SynthesizedAudio } from './tts.js';

/** Milliseconds of audio held back so the last frame of a segment can be tagged `final`. */
const TAIL_MS = 10;

/**
 * Only start watching for slow generation once this much audio has been sent. Below it the
 * progressive ramp-up makes the realtime comparison meaningless.
 */
const SLOW_GENERATION_MIN_SENT_MS = 150;

/** Safety margin subtracted from the slow-generation deadline. */
const SLOW_GENERATION_MARGIN_MS = 20;

/** Where an {@link AudioEmitter} writes finished packets. Satisfied by `AsyncIterableQueue`. */
export interface AudioEmitterDestination {
  put(audio: SynthesizedAudio): void;
  readonly closed: boolean;
}

export interface AudioEmitterOptions {
  /** TTS label, used for logging and debugging. */
  label: string;
  /** Destination the emitter writes {@link SynthesizedAudio} packets to. */
  destination: AudioEmitterDestination;
}

export interface AudioEmitterInitializeOptions {
  /** Request ID reported on every emitted packet. */
  requestId: string;
  /** Sample rate of the audio the provider returns. */
  sampleRate: number;
  /** Channel count of the audio the provider returns. */
  numChannels: number;
  /**
   * MIME type of the bytes that will be pushed.
   *
   * `audio/pcm` and `audio/raw` are written straight through. Anything else is decoded with
   * {@link AudioStreamDecoder}, so container and compressed formats (`audio/mpeg`, `audio/wav`,
   * `audio/ogg`, …) can be pushed as-is.
   */
  mimeType: string;
  /** Target frame size once progressive ramp-up completes. Defaults to 200ms. */
  frameSizeMs?: number;
  /**
   * Whether the emitter serves a streaming TTS, where the plugin opens and closes each segment
   * itself with {@link AudioEmitter.startSegment} and {@link AudioEmitter.endSegment}.
   *
   * When `false` (the default) a single anonymous segment is opened automatically.
   */
  stream?: boolean;
}

type WriteEvent =
  | { type: 'startSegment'; segmentId: string }
  | { type: 'endSegment' }
  | { type: 'flushSegment' }
  | { type: 'bytes'; data: Uint8Array }
  | { type: 'frame'; frame: AudioFrame }
  | { type: 'timedTranscript'; text: TimedString };

interface SegmentContext {
  segmentId: string;
  audioDuration: number;
}

/** Duration of a frame in milliseconds. */
const frameDurationMs = (frame: AudioFrame): number =>
  (frame.samplesPerChannel / frame.sampleRate) * 1000;

/**
 * Turns raw provider bytes into correctly-framed {@link SynthesizedAudio} packets.
 *
 * An emitter owns everything between "the provider sent us some bytes" and "the pipeline has a
 * frame it can play": decoding non-PCM formats, chunking into frames, tracking segments and
 * their durations, and marking the last frame of each segment `final`.
 *
 * Lifecycle:
 *
 * 1. {@link initialize} once, as soon as the response format is known.
 * 2. {@link push} bytes as they arrive. For a streaming TTS, bracket each segment with
 *    {@link startSegment} / {@link endSegment}.
 * 3. {@link endInput} when the provider is done, then {@link join} to wait for the tail of the
 *    audio to be emitted.
 * 4. {@link aclose} on an abandoned stream, to release the decoder subprocess.
 *
 * Frames ramp up progressively (20ms, 40ms, 80ms, … up to `frameSizeMs`) so the first audio
 * reaches the pipeline as early as possible. If the provider generates slower than realtime, the
 * emitter flushes the buffered tail on its own rather than letting the consumer starve.
 *
 * @example Non-streaming, provider returns MP3
 * ```ts
 * const emitter = new AudioEmitter({ label: this.label, destination: this.queue });
 * emitter.initialize({ requestId, sampleRate: 24000, numChannels: 1, mimeType: 'audio/mpeg' });
 * for await (const chunk of response.body) emitter.push(chunk);
 * emitter.endInput();
 * await emitter.join();
 * ```
 */
export class AudioEmitter {
  #label: string;
  #destination: AudioEmitterDestination;
  #logger = log();

  #started = false;
  #requestId = '';
  #sampleRate = 0;
  #numChannels = 0;
  #frameSizeMs = 200;
  #streaming = false;
  #mimeType = '';
  #isRawPcm = false;

  #numSegments = 0;
  #audioDurations: number[] = [];

  #writeQueue?: AsyncIterableQueue<WriteEvent>;
  #mainTask?: Promise<void>;
  #aborted = false;

  constructor(opts: AudioEmitterOptions) {
    this.#label = opts.label;
    this.#destination = opts.destination;
  }

  /** Milliseconds of audio emitted for a segment. Defaults to the most recent one. */
  pushedDuration(idx: number = -1): number {
    const resolved = idx < 0 ? this.#audioDurations.length + idx : idx;
    return this.#audioDurations[resolved] ?? 0;
  }

  /** Number of segments started so far. */
  get numSegments(): number {
    return this.#numSegments;
  }

  /** Whether {@link initialize} has been called. */
  get started(): boolean {
    return this.#started;
  }

  initialize(opts: AudioEmitterInitializeOptions): void {
    if (this.#started) {
      throw new Error('AudioEmitter already started');
    }

    this.#mimeType = opts.mimeType;
    this.#isRawPcm = isRawPcm(opts.mimeType);

    let requestId = opts.requestId;
    if (!requestId) {
      this.#logger.warn({ tts: this.#label }, 'no requestId provided for TTS');
      requestId = 'unknown';
    }

    this.#started = true;
    this.#requestId = requestId;
    this.#sampleRate = opts.sampleRate;
    this.#numChannels = opts.numChannels;
    this.#frameSizeMs = opts.frameSizeMs ?? 200;
    this.#streaming = opts.stream ?? false;

    this.#writeQueue = new AsyncIterableQueue<WriteEvent>();
    const task = this.#runMainTask().catch((error) => {
      this.#logger.error({ tts: this.#label, error }, 'error in AudioEmitter main task');
      throw toError(error);
    });
    // Mark the rejection handled up front: a plugin that pushes bytes and never calls join()
    // (an abandoned synthesis, say) must not take the process down with an unhandled
    // rejection. join() awaits the same promise, so it still surfaces the error there.
    task.catch(() => {});
    this.#mainTask = task;

    if (!this.#streaming) {
      // A non-streaming TTS has exactly one segment; open it so the plugin doesn't have to.
      this.#startSegment('');
    }
  }

  /** Accumulate emitted audio against the segment currently being filled. */
  #addSegmentDuration(durationMs: number): void {
    const idx = this.#audioDurations.length - 1;
    if (idx < 0) {
      return;
    }
    this.#audioDurations[idx] = (this.#audioDurations[idx] ?? 0) + durationMs;
  }

  #assertStarted(): void {
    if (!this.#started) {
      throw new Error("AudioEmitter isn't started");
    }
  }

  /** Push an event, dropping it if the emitter has already been closed off. */
  #write(event: WriteEvent): void {
    this.#assertStarted();
    if (!this.#writeQueue || this.#writeQueue.closed) {
      return;
    }
    this.#writeQueue.put(event);
  }

  #startSegment(segmentId: string): void {
    this.#assertStarted();
    if (!this.#writeQueue || this.#writeQueue.closed) {
      return;
    }
    this.#numSegments += 1;
    this.#writeQueue.put({ type: 'startSegment', segmentId });
  }

  /**
   * Open a new segment. Streaming only — a non-streaming emitter opens its single segment during
   * {@link initialize}.
   */
  startSegment(opts: { segmentId: string }): void {
    if (!this.#streaming) {
      throw new Error(
        'startSegment() can only be called when the emitter is initialized with stream: true',
      );
    }
    this.#startSegment(opts.segmentId);
  }

  /** Close the current segment, emitting its held-back tail as the `final` frame. */
  endSegment(): void {
    if (!this.#streaming) {
      throw new Error(
        'endSegment() can only be called when the emitter is initialized with stream: true',
      );
    }
    this.#write({ type: 'endSegment' });
  }

  /** Push encoded or raw bytes from the provider. */
  push(data: Uint8Array): void {
    this.#write({ type: 'bytes', data });
  }

  /**
   * Forward an already-framed chunk as-is, skipping the progressive re-chunking of
   * {@link push}. For adapters wrapping a TTS whose emitter already framed the audio.
   */
  pushFrame(frame: AudioFrame): void {
    this.#write({ type: 'frame', frame });
  }

  /** Attach word-level timestamps to the next emitted packet. */
  pushTimedTranscript(delta: TimedString | TimedString[]): void {
    const items = Array.isArray(delta) ? delta : [delta];
    for (const text of items) {
      this.#write({ type: 'timedTranscript', text });
    }
  }

  /** Release the buffered tail without ending the segment. */
  flush(): void {
    this.#write({ type: 'flushSegment' });
  }

  /** Signal that the provider has sent its last byte. */
  endInput(): void {
    this.#assertStarted();
    if (!this.#writeQueue || this.#writeQueue.closed) {
      return;
    }
    this.#writeQueue.put({ type: 'endSegment' });
    this.#writeQueue.close();
  }

  /** Wait for every pushed byte to be emitted. Rejects if decoding failed. */
  async join(): Promise<void> {
    this.#assertStarted();
    await this.#mainTask;
  }

  /**
   * Abandon the emitter, releasing the decoder subprocess without draining buffered audio.
   *
   * Safe to call more than once, and safe to call on an emitter that was never initialized.
   */
  async aclose(): Promise<void> {
    if (!this.#started) {
      return;
    }
    this.#aborted = true;
    if (this.#writeQueue && !this.#writeQueue.closed) {
      this.#writeQueue.close();
    }
    // The main task owns the decoder and closes it in its own `finally`.
    await this.#mainTask?.catch(() => {});
  }

  async #runMainTask(): Promise<void> {
    const writeQueue = this.#writeQueue!;

    let decoder: AudioStreamDecoder | undefined;
    let decodeTask: Promise<void> | undefined;
    let segmentCtx: SegmentContext | undefined;
    let lastFrame: AudioFrame | undefined;
    let timedTranscripts: TimedString[] = [];
    let byteStream: AudioByteStream | undefined;

    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    let sentStart: number | undefined;
    let sentDuration = 0;

    const tailSamples = Math.floor((this.#sampleRate * TAIL_MS) / 1000);

    const clearFlushTimer = () => {
      if (flushTimer !== undefined) {
        clearTimeout(flushTimer);
        flushTimer = undefined;
      }
    };

    const sendAudio = (audio: SynthesizedAudio, flushIfDelayed: boolean) => {
      if (this.#destination.closed) {
        return;
      }
      this.#destination.put(audio);

      sentStart ??= performance.now();
      sentDuration += frameDurationMs(audio.frame);

      clearFlushTimer();

      if (flushIfDelayed && sentDuration > SLOW_GENERATION_MIN_SENT_MS) {
        // Force a flush if audio arrives slower than realtime, so the consumer never starves
        // on a tail we are holding back.
        const delayMs = sentDuration - (performance.now() - sentStart) - SLOW_GENERATION_MARGIN_MS;
        if (delayMs > 0) {
          flushTimer = setTimeout(() => {
            this.#logger.debug({ tts: this.#label }, 'flushing audio emitter, slow generation');
            this.flush();
          }, delayMs);
        }
      }
    };

    /**
     * Split `frame` into head and a tail of exactly `tailSamples`, or `[undefined, frame]` when
     * the frame is too short to split.
     */
    const splitTail = (frame: AudioFrame): [AudioFrame | undefined, AudioFrame] => {
      if (frame.samplesPerChannel <= tailSamples) {
        return [undefined, frame];
      }
      const headSamples = frame.samplesPerChannel - tailSamples;
      const splitIdx = headSamples * frame.channels;
      const head = new AudioFrame(
        frame.data.slice(0, splitIdx),
        frame.sampleRate,
        frame.channels,
        headSamples,
      );
      const tail = new AudioFrame(
        frame.data.slice(splitIdx),
        frame.sampleRate,
        frame.channels,
        tailSamples,
      );
      return [head, tail];
    };

    const doSend = (frame: AudioFrame, isFinal: boolean) => {
      const ctx = segmentCtx!;
      const transcripts = timedTranscripts;
      timedTranscripts = [];
      sendAudio(
        {
          frame,
          requestId: this.#requestId,
          segmentId: ctx.segmentId,
          final: isFinal,
          ...(transcripts.length > 0 ? { timedTranscripts: transcripts } : {}),
        },
        !isFinal,
      );
      ctx.audioDuration += frameDurationMs(frame);
      this.#addSegmentDuration(frameDurationMs(frame));
    };

    const emitFrame = (frame?: AudioFrame, isFinal = false) => {
      const ctx = segmentCtx!;

      if (isFinal) {
        // End of segment — release everything we were holding back.
        if (lastFrame && frame) {
          doSend(mergeFrames([lastFrame, frame]), true);
          lastFrame = undefined;
        } else if (lastFrame) {
          doSend(lastFrame, true);
          lastFrame = undefined;
        } else if (frame) {
          doSend(frame, true);
        } else if (ctx.audioDuration > 0) {
          // The segment had audio but nothing is left to mark final; send a short silent
          // marker so downstream sees a terminator. Synthetic silence, so it doesn't count
          // toward the segment's duration.
          const markerSamples = Math.floor(this.#sampleRate / 100);
          const marker = new AudioFrame(
            new Int16Array(markerSamples * this.#numChannels),
            this.#sampleRate,
            this.#numChannels,
            markerSamples,
          );
          const transcripts = timedTranscripts;
          timedTranscripts = [];
          sendAudio(
            {
              frame: marker,
              requestId: this.#requestId,
              segmentId: ctx.segmentId,
              final: true,
              ...(transcripts.length > 0 ? { timedTranscripts: transcripts } : {}),
            },
            false,
          );
        }
        return;
      }

      if (!frame) {
        return;
      }

      // Normal frame: send as much as possible but hold a small tail back, so the last audio
      // of the segment can still be tagged `final`.
      const combined = lastFrame ? mergeFrames([lastFrame, frame]) : frame;
      const [head, tail] = splitTail(combined);
      if (head) {
        doSend(head, false);
      }
      lastFrame = tail;
    };

    const flushFrame = () => {
      if (!lastFrame || !segmentCtx) {
        return;
      }
      const transcripts = timedTranscripts;
      timedTranscripts = [];
      sendAudio(
        {
          frame: lastFrame,
          requestId: this.#requestId,
          segmentId: segmentCtx.segmentId,
          final: false, // a flush is not the end of the segment
          ...(transcripts.length > 0 ? { timedTranscripts: transcripts } : {}),
        },
        false, // don't re-arm the timer before new frames are pushed
      );
      segmentCtx.audioDuration += frameDurationMs(lastFrame);
      this.#addSegmentDuration(frameDurationMs(lastFrame));
      lastFrame = undefined;

      sentStart = undefined;
      sentDuration = 0;
      clearFlushTimer();
    };

    const drainDecoder = async (activeDecoder: AudioStreamDecoder) => {
      let decodedBytes: AudioByteStream | undefined;
      for await (const frame of activeDecoder) {
        decodedBytes ??= new AudioByteStream(
          frame.sampleRate,
          frame.channels,
          Math.floor((frame.sampleRate / 1000) * this.#frameSizeMs),
          true,
        );
        for (const f of decodedBytes.write(frame.data)) {
          emitFrame(f);
        }
      }
      if (decodedBytes) {
        for (const f of decodedBytes.flush()) {
          emitFrame(f);
        }
      }
    };

    try {
      for await (const event of writeQueue) {
        if (this.#aborted) {
          break;
        }

        if (event.type === 'timedTranscript') {
          timedTranscripts.push(event.text);
          continue;
        }

        if (event.type === 'startSegment') {
          if (segmentCtx) {
            throw new Error('startSegment() called before the previous segment was ended');
          }
          this.#audioDurations.push(0);
          segmentCtx = { segmentId: event.segmentId, audioDuration: 0 };
          continue;
        }

        if (!segmentCtx) {
          if (event.type === 'endSegment' || event.type === 'flushSegment') {
            continue; // empty segment, nothing to do
          }
          throw new Error('startSegment() must be called before pushing audio data');
        }

        if (this.#isRawPcm) {
          switch (event.type) {
            case 'frame':
              emitFrame(event.frame);
              break;
            case 'bytes':
              byteStream ??= new AudioByteStream(
                this.#sampleRate,
                this.#numChannels,
                Math.floor((this.#sampleRate / 1000) * this.#frameSizeMs),
                true,
              );
              for (const f of byteStream.write(event.data)) {
                emitFrame(f);
              }
              break;
            case 'flushSegment':
              if (byteStream) {
                for (const f of byteStream.flush()) {
                  emitFrame(f);
                }
                // More bytes can follow a flush; keep any partial PCM sample and restart the
                // progressive ramp so the next burst is responsive again.
                byteStream.resetProgressive();
              }
              flushFrame();
              break;
            case 'endSegment':
              if (byteStream) {
                for (const f of byteStream.flush()) {
                  emitFrame(f);
                }
                if (byteStream.bufferedDuration > 0) {
                  this.#logger.warn(
                    { tts: this.#label, requestId: this.#requestId },
                    'incomplete PCM sample at end of segment, discarding trailing bytes',
                  );
                }
              }
              emitFrame(undefined, true);
              segmentCtx = undefined;
              byteStream = undefined;
              lastFrame = undefined;
              break;
          }
          continue;
        }

        // Encoded audio: everything goes through the decoder subprocess.
        if (event.type === 'bytes') {
          if (!decoder) {
            decoder = new AudioStreamDecoder({
              sampleRate: this.#sampleRate,
              numChannels: this.#numChannels,
              format: this.#mimeType,
            });
            decodeTask = drainDecoder(decoder);
          }
          decoder.push(event.data);
        } else if (event.type === 'frame') {
          // Already-framed audio needs no decoding, whatever the declared MIME type.
          emitFrame(event.frame);
        } else if (decodeTask && decoder) {
          if (event.type === 'flushSegment') {
            // Don't tear the decoder down here. A slow-generation flush can fire while a
            // stateful codec (WAV/OGG/MP3) is mid-file; ending input would discard the parser,
            // and the following bytes — a packet continuation with no fresh container header —
            // would not parse against a newly created decoder. A flush only needs to release
            // the held-back tail so a slow provider doesn't starve the consumer.
            flushFrame();
          } else if (event.type === 'endSegment') {
            decoder.endInput();
            await decodeTask;
            await decoder.aclose();
            emitFrame(undefined, true);
            decoder = undefined;
            decodeTask = undefined;
            segmentCtx = undefined;
            byteStream = undefined;
            lastFrame = undefined;
          }
        } else if (event.type === 'endSegment') {
          // Segment ended without a single byte being pushed.
          emitFrame(undefined, true);
          segmentCtx = undefined;
          lastFrame = undefined;
        }
      }
    } finally {
      clearFlushTimer();
      if (decoder) {
        await decoder.aclose();
        await decodeTask?.catch(() => {});
      }
    }
  }
}
