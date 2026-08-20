// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Mutex } from '@livekit/mutex';
import { AudioFrame, AudioResampler } from '@livekit/rtc-node';
import ffmpeg from 'fluent-ffmpeg';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { ReadableStream } from 'node:stream/web';
import { TransformStream } from 'node:stream/web';
import { configureFfmpeg } from '../../ffmpeg.js';
import { log } from '../../log.js';
import { isStreamReaderReleaseError } from '../../stream/deferred_stream.js';
import { type StreamChannel, createStreamChannel } from '../../stream/stream_channel.js';
import {
  Future,
  Task,
  cancelAndWait,
  delay,
  isFfmpegTeardownError,
  isWritableStreamClosedError,
} from '../../utils.js';
import type { AgentSession } from '../agent_session.js';
import { AudioInput, AudioOutput, type PlaybackFinishedEvent } from '../io.js';
import { createSilenceFrame } from '../utils.js';

configureFfmpeg();

const WRITE_INTERVAL_MS = 2500;
const DEFAULT_SAMPLE_RATE = 48000;
const CLOSE_PLAYOUT_FLUSH_TIMEOUT_MS = 2000;

export interface RecorderOptions {
  agentSession: AgentSession;
  sampleRate?: number;
}

interface ResampleAndMixOptions {
  frames: AudioFrame[];
  resampler: AudioResampler | undefined;
  flush?: boolean;
}

export class RecorderIO {
  private inRecord?: RecorderAudioInput;
  private outRecord?: RecorderAudioOutput;

  private inChan: StreamChannel<AudioFrame[]> = createStreamChannel<AudioFrame[]>();
  private outChan: StreamChannel<AudioFrame[]> = createStreamChannel<AudioFrame[]>();

  private session: AgentSession;
  private sampleRate: number;

  private _outputPath?: string;
  private forwardTask?: Task<void>;
  private encodeTask?: Task<void>;

  private closeFuture: Future<void> = new Future();
  private lock: Mutex = new Mutex();
  private started: boolean = false;
  private closing: boolean = false;
  private closePlayoutFlushTimeoutMs: number = CLOSE_PLAYOUT_FLUSH_TIMEOUT_MS;

  // FFmpeg streaming state
  private pcmStream?: PassThrough;
  private ffmpegPromise?: Promise<void>;
  private inResampler?: AudioResampler;
  private outResampler?: AudioResampler;

  private logger = log();

  constructor(opts: RecorderOptions) {
    const { agentSession, sampleRate = DEFAULT_SAMPLE_RATE } = opts;

    this.session = agentSession;
    this.sampleRate = sampleRate;
  }

  async start(outputPath: string): Promise<void> {
    const unlock = await this.lock.lock();

    try {
      if (this.started) return;

      if (!this.inRecord || !this.outRecord) {
        throw new Error(
          'RecorderIO not properly initialized: both `recordInput()` and `recordOutput()` must be called before starting the recorder.',
        );
      }

      this._outputPath = outputPath;
      this.started = true;
      this.closing = false;
      this.closeFuture = new Future();

      // Ensure output directory exists
      const dir = path.dirname(outputPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      this.forwardTask = Task.from(({ signal }) => this.forward(signal));
      this.encodeTask = Task.from(() => this.encode(), undefined, 'recorder_io_encode_task');
    } finally {
      unlock();
    }
  }

  async close(): Promise<void> {
    const unlock = await this.lock.lock();

    try {
      if (!this.started) return;

      // No further frames can reach the output once we are closing, so seal the open segment.
      // A segment the downstream output never accepted can then settle immediately instead of
      // stalling teardown for the full flush timeout and warning about audio it was never
      // going to keep.
      this.outRecord?._sealOpenSegment();

      // On a force-interrupted shutdown, the session marks the speech done
      // before playout settles, so the playout finished event may still be in flight.
      // Give it a bounded window to land before fencing writers out.
      if (this.outRecord?.hasPendingData) {
        const timeoutController = new AbortController();
        await Promise.race([
          this.outRecord.waitForPlayout(),
          delay(this.closePlayoutFlushTimeoutMs, { signal: timeoutController.signal }).catch(
            () => {},
          ),
        ]);
        timeoutController.abort();

        if (this.outRecord.hasPendingData) {
          this.logger.warn(
            'RecorderIO closed before the last playback finished; dropping unflushed agent audio',
          );
        }
      }

      // Establish shutdown fence before any async operations, so no writer can proceed.
      this.closing = true;
      this.started = false;

      if (this.forwardTask) {
        await cancelAndWait([this.forwardTask]);
        this.forwardTask = undefined;
      }

      // Flush input captured since the last write so the recording tail isn't dropped.
      const inputBuf = this.inRecord?.takeBuf(this.outRecord?._lastSpeechEndTime) ?? [];
      if (inputBuf.length > 0) {
        try {
          await this.inChan.write(inputBuf);
          await this.outChan.write([]);
        } catch (err) {
          if (!isWritableStreamClosedError(err)) {
            this.logger.error({ err }, 'Error writing final RecorderIO input buffer');
          }
        }
      }

      await this.inChan.close();
      await this.outChan.close();
      await this.closeFuture.await;

      if (this.encodeTask) {
        await cancelAndWait([this.encodeTask]);
      }

      await this.inRecord?.close();
      this.closing = false;
    } finally {
      unlock();
    }
  }

  recordInput(audioInput: AudioInput): RecorderAudioInput {
    this.inRecord = new RecorderAudioInput(this, audioInput);
    return this.inRecord;
  }

  recordOutput(audioOutput: AudioOutput): RecorderAudioOutput {
    this.outRecord = new RecorderAudioOutput(this, audioOutput, (buf) => this.writeCb(buf));
    return this.outRecord;
  }

  private writeCb(buf: AudioFrame[]): void {
    if (!this.started || this.closing || this.inChan.closed || this.outChan.closed) {
      return;
    }

    const inputBuf = this.inRecord!.takeBuf(this.outRecord?._lastSpeechEndTime);
    this.inChan.write(inputBuf).catch((err) => {
      if (!isWritableStreamClosedError(err)) {
        this.logger.error({ err }, 'Error writing RecorderIO input buffer');
      }
    });
    this.outChan.write(buf).catch((err) => {
      if (!isWritableStreamClosedError(err)) {
        this.logger.error({ err }, 'Error writing RecorderIO output buffer');
      }
    });
  }

  get recording(): boolean {
    return this.started;
  }

  get outputPath(): string | undefined {
    return this._outputPath;
  }

  get recordingStartedAt(): number | undefined {
    const inT = this.inRecord?.startedWallTime;
    const outT = this.outRecord?.startedWallTime;

    if (inT === undefined) {
      return outT;
    }

    if (outT === undefined) {
      return inT;
    }

    return Math.min(inT, outT);
  }

  /**
   * Forward task: periodically flush input buffer to encoder
   */
  private async forward(signal: AbortSignal): Promise<void> {
    while (!signal.aborted && this.started && !this.closing) {
      try {
        await delay(WRITE_INTERVAL_MS, { signal });
      } catch {
        // Aborted
        break;
      }

      if (this.outRecord!.hasPendingData) {
        // If the output is currently playing audio, wait for it to stay in sync
        continue;
      }

      // Flush input buffer
      const inputBuf = this.inRecord!.takeBuf(this.outRecord!._lastSpeechEndTime);
      try {
        await this.inChan.write(inputBuf);
        await this.outChan.write([]);
      } catch (err) {
        if (this.inChan.closed || this.outChan.closed || isWritableStreamClosedError(err)) {
          // Channel closure is expected during teardown; stop forwarding to avoid noisy logs.
          break;
        }

        this.logger.error({ err }, 'Error writing RecorderIO output buffer');
      }
    }
  }

  /**
   * Start FFmpeg process for streaming encoding
   */
  private startFFmpeg(): void {
    if (this.pcmStream) return;

    this.pcmStream = new PassThrough();

    this.ffmpegPromise = new Promise<void>((resolve, reject) => {
      ffmpeg(this.pcmStream!)
        .inputFormat('s16le')
        .inputOptions([`-ar ${this.sampleRate}`, '-ac 2'])
        .audioCodec('libopus')
        .audioChannels(2)
        .audioFrequency(this.sampleRate)
        .format('ogg')
        .output(this._outputPath!)
        .on('end', () => {
          this.logger.debug('FFmpeg encoding finished');
          resolve();
        })
        .on('error', (err) => {
          // Ignore errors from intentional stream closure or SIGINT during shutdown
          if (isFfmpegTeardownError(err)) {
            resolve();
          } else {
            this.logger.error({ err }, 'FFmpeg encoding error');
            reject(err);
          }
        })
        .run();
    });
  }

  /**
   * Resample and mix frames to mono Float32
   */
  private resampleAndMix(opts: ResampleAndMixOptions): {
    samples: Float32Array;
    resampler: AudioResampler | undefined;
  } {
    const INV_INT16 = 1.0 / 32768.0;
    const { frames, flush = false } = opts;
    let { resampler } = opts;

    if (frames.length === 0 && !flush) {
      return { samples: new Float32Array(0), resampler };
    }

    if (!resampler && frames.length > 0) {
      const firstFrame = frames[0]!;
      resampler = new AudioResampler(firstFrame.sampleRate, this.sampleRate, firstFrame.channels);
    }

    const resampledFrames: AudioFrame[] = [];
    for (const frame of frames) {
      if (resampler) {
        resampledFrames.push(...resampler.push(frame));
      }
    }

    if (flush && resampler) {
      resampledFrames.push(...resampler.flush());
    }

    const totalSamples = resampledFrames.reduce((acc, frame) => acc + frame.samplesPerChannel, 0);
    const samples = new Float32Array(totalSamples);

    let pos = 0;
    for (const frame of resampledFrames) {
      const data = frame.data;
      const numChannels = frame.channels;
      for (let i = 0; i < frame.samplesPerChannel; i++) {
        let sum = 0;
        for (let ch = 0; ch < numChannels; ch++) {
          sum += data[i * numChannels + ch]!;
        }
        samples[pos++] = (sum / numChannels) * INV_INT16;
      }
    }

    return { samples, resampler };
  }

  /**
   * Write PCM chunk to FFmpeg stream
   */
  private writePCM(leftSamples: Float32Array, rightSamples: Float32Array): void {
    if (!this.pcmStream) {
      this.startFFmpeg();
    }

    // Handle length mismatch by prepending silence
    if (leftSamples.length !== rightSamples.length) {
      const diff = Math.abs(leftSamples.length - rightSamples.length);
      if (leftSamples.length < rightSamples.length) {
        this.logger.warn(
          `Input is shorter by ${diff} samples; silence has been prepended to align the input channel.`,
        );
        const padded = new Float32Array(rightSamples.length);
        padded.set(leftSamples, diff);
        leftSamples = padded;
      } else {
        const padded = new Float32Array(leftSamples.length);
        padded.set(rightSamples, diff);
        rightSamples = padded;
      }
    }

    const maxLen = Math.max(leftSamples.length, rightSamples.length);
    if (maxLen <= 0) return;

    // Interleave stereo samples and convert back to Int16
    const stereoData = new Int16Array(maxLen * 2);
    for (let i = 0; i < maxLen; i++) {
      stereoData[i * 2] = Math.max(
        -32768,
        Math.min(32767, Math.round((leftSamples[i] ?? 0) * 32768)),
      );
      stereoData[i * 2 + 1] = Math.max(
        -32768,
        Math.min(32767, Math.round((rightSamples[i] ?? 0) * 32768)),
      );
    }

    this.pcmStream!.write(Buffer.from(stereoData.buffer));
  }

  /**
   * Encode task: read from channels, mix to stereo, stream to FFmpeg
   */
  private async encode(): Promise<void> {
    if (!this._outputPath) return;

    const inReader = this.inChan.stream().getReader();
    const outReader = this.outChan.stream().getReader();

    try {
      while (true) {
        const [inResult, outResult] = await Promise.all([inReader.read(), outReader.read()]);

        if (inResult.done || outResult.done) {
          break;
        }

        const inputBuf = inResult.value;
        const outputBuf = outResult.value;

        const inMixed = this.resampleAndMix({ frames: inputBuf, resampler: this.inResampler });
        this.inResampler = inMixed.resampler;

        const outMixed = this.resampleAndMix({
          frames: outputBuf,
          resampler: this.outResampler,
          flush: outputBuf.length > 0,
        });
        this.outResampler = outMixed.resampler;

        // Stream PCM data directly to FFmpeg
        this.writePCM(inMixed.samples, outMixed.samples);
      }

      // Close FFmpeg stream and wait for encoding to complete
      if (this.pcmStream) {
        this.pcmStream.end();
        await this.ffmpegPromise;
      }
    } catch (err) {
      this.logger.error({ err }, 'Error in encode task');
    } finally {
      try {
        inReader.releaseLock();
        outReader.releaseLock();
        this.inResampler?.close();
        this.outResampler?.close();
      } finally {
        if (!this.closeFuture.done) {
          this.closeFuture.resolve();
        }
      }
    }
  }
}

class RecorderAudioInput extends AudioInput {
  private source: AudioInput;
  private recorderIO: RecorderIO;
  private accFrames: AudioFrame[] = [];
  private _startedWallTime?: number;
  private _padded: boolean = false;
  private logger = log();

  constructor(recorderIO: RecorderIO, source: AudioInput) {
    super();
    this.recorderIO = recorderIO;
    this.source = source;

    // Set up the intercepting stream
    this.multiStream.addInputStream(this.createInterceptingStream());
  }

  /**
   * Wall-clock time when the first frame was captured
   */
  get startedWallTime(): number | undefined {
    return this._startedWallTime;
  }

  /**
   * Take accumulated frames and clear the buffer
   * @param padSince - If provided and input started after this time, pad with silence
   */
  takeBuf(padSince?: number): AudioFrame[] {
    let frames = this.accFrames;
    this.accFrames = [];

    if (
      padSince !== undefined &&
      this._startedWallTime !== undefined &&
      this._startedWallTime > padSince &&
      !this._padded &&
      frames.length > 0
    ) {
      const padding = this._startedWallTime - padSince;
      this.logger.warn(
        {
          lastAgentSpeechTime: padSince,
          inputStartedTime: this._startedWallTime,
        },
        'input speech started after last agent speech ended',
      );
      this._padded = true;
      const firstFrame = frames[0]!;
      frames = [createSilenceFrame(padding, firstFrame.sampleRate, firstFrame.channels), ...frames];
    } else if (
      padSince !== undefined &&
      this._startedWallTime === undefined &&
      !this._padded &&
      frames.length === 0
    ) {
      // We could pad with silence here with some fixed SR and channels,
      // but it's better for the user to know that this is happening
      this.logger.warn(
        "input speech hasn't started yet, skipping silence padding, recording may be inaccurate until the speech starts",
      );
    }

    return frames;
  }

  /**
   * Creates a stream that intercepts frames from the source,
   * accumulates them when recording, and passes them through unchanged.
   */
  private createInterceptingStream(): ReadableStream<AudioFrame> {
    const sourceStream = this.source.stream;
    const reader = sourceStream.getReader();

    const transform = new TransformStream<AudioFrame, AudioFrame>({
      transform: (frame, controller) => {
        // Accumulate frames when recording is active
        if (this.recorderIO.recording) {
          if (this._startedWallTime === undefined) {
            this._startedWallTime = Date.now();
          }
          this.accFrames.push(frame);
        }

        controller.enqueue(frame);
      },
    });

    const pump = async () => {
      const writer = transform.writable.getWriter();
      let sourceError: unknown;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          await writer.write(value);
        }
      } catch (e) {
        if (isStreamReaderReleaseError(e)) return;
        sourceError = e;
      } finally {
        if (sourceError) {
          writer.abort(sourceError);
          return;
        }

        writer.releaseLock();

        try {
          await transform.writable.close();
        } catch {
          // ignore "WritableStream is closed" errors
        }
      }
    };

    pump();

    return transform.readable;
  }

  override setAttached(attached: boolean): void {
    super.setAttached(attached);
    this.source.setAttached(attached);
  }

  onAttached(): void {
    this.source.onAttached();
  }

  onDetached(): void {
    this.source.onDetached();
  }
}

interface RecorderOutputSegment {
  frames: AudioFrame[];
  acceptedDownstream: boolean;
  captureFailed: boolean;
  capturesInFlight: number;
  finishRequested: boolean;
  flushed: boolean;
  /**
   * Set once a caller has waited for this segment's playout *and* the wrapped output has
   * reported its own playout complete. At that point the wrapped output is holding nothing
   * for us, so a segment it never accepted can no longer be finished by anyone — which is the
   * same guarantee a flush gives {@link RecorderAudioOutput.drainFinishes}, arrived at from
   * the other side.
   */
  playoutAwaited: boolean;
  playbackEvent?: PlaybackFinishedEvent;
  /** Wall-clock time the segment was opened, i.e. when its first frame entered `captureFrame`. */
  speechStartTime: number;
  currentPauseStart?: number;
  pauseWallTimes: Array<[number, number]>;
}

class RecorderAudioOutput extends AudioOutput {
  private recorderIO: RecorderIO;
  private writeFn: (buf: AudioFrame[]) => void;
  private segments: RecorderOutputSegment[] = [];
  private currentSegment?: RecorderOutputSegment;
  private deferredFinishes: PlaybackFinishedEvent[] = [];
  private _startedWallTime?: number;
  private currentPauseStart?: number;
  private pauseWallTimes: Array<[number, number]> = [];
  private _logger = log();

  _lastSpeechEndTime?: number;

  constructor(
    recorderIO: RecorderIO,
    audioOutput: AudioOutput,
    writeFn: (buf: AudioFrame[]) => void,
  ) {
    super(audioOutput.sampleRate, audioOutput, { pause: true });
    this.recorderIO = recorderIO;
    this.writeFn = writeFn;
  }

  get startedWallTime(): number | undefined {
    return this._startedWallTime;
  }

  get hasPendingData(): boolean {
    return this.segments.some((segment) => segment.frames.length > 0);
  }

  pause(): void {
    if (this.currentPauseStart === undefined && this.recorderIO.recording) {
      this.currentPauseStart = Date.now();
    }

    const segment = this.currentSegment ?? this.segments.at(-1);
    if (segment && segment.currentPauseStart === undefined && this.recorderIO.recording) {
      segment.currentPauseStart = this.currentPauseStart;
    }

    if (this.nextInChain) {
      this.nextInChain.pause();
    }
  }

  /**
   * Resume playback and record the pause interval
   */
  resume(): void {
    const resumedAt = Date.now();
    if (this.currentPauseStart !== undefined && this.recorderIO.recording) {
      this.pauseWallTimes.push([this.currentPauseStart, resumedAt]);
      this.currentPauseStart = undefined;
    }

    const segment = this.currentSegment ?? this.segments.at(-1);
    if (segment?.currentPauseStart !== undefined && this.recorderIO.recording) {
      segment.pauseWallTimes.push([segment.currentPauseStart, resumedAt]);
      segment.currentPauseStart = undefined;
    }

    if (this.nextInChain) {
      this.nextInChain.resume();
    }
  }

  onPlaybackFinished(options: PlaybackFinishedEvent): void {
    this.deferredFinishes.push(options);
    this.drainFinishes();
  }

  /**
   * Settle segments in capture order against the finishes the downstream output has sent.
   *
   * Segments are settled oldest-first so a finish is always attributed to the segment it
   * belongs to. A finish that arrives with nothing to attribute it to yet stays queued in
   * `deferredFinishes` rather than being forwarded (and dropped) immediately.
   */
  private drainFinishes(): void {
    while (this.segments.length > 0) {
      const segment = this.segments[0]!;
      if (segment.capturesInFlight > 0) {
        return;
      }

      if (!segment.acceptedDownstream) {
        // A segment the downstream output never counted will never receive a real finish, so
        // we synthesize one. Before doing that we need to know the segment can no longer grow,
        // or we would settle one that is still being captured into. A flush proves that, and
        // so does `playoutAwaited`: a caller is waiting on this segment and the wrapped output
        // has already reported its own playout done, so nothing is left that could finish it.
        //
        // Requiring the flush *alone* is not enough. It happens to hold for every in-tree
        // caller today — `forwardAudio` flushes in a `finally` and is the only code that
        // captures frames, `agent_activity.ts` awaits `cancelAndWait` on the forward tasks
        // before it waits for playout, and `RecorderIO.close()` seals the open segment — but
        // that is an accident of ordering inside somebody else's `finally`, not a contract.
        // A caller that waits without flushing is asking a well-formed question, and hanging
        // is the wrong answer to it.
        if (!segment.flushed && !segment.playoutAwaited) {
          return;
        }
        this.finishSegment(segment, { playbackPosition: 0, interrupted: true });
        continue;
      }

      // A real finish from the downstream output is authoritative: the sink counted this
      // segment and is now telling us it is over, so we settle it whether or not we have been
      // flushed. The `AudioOutput` contract lets a sink report a finish as soon as its playout
      // ends, with no flush involved, and `SyncedAudioOutput.waitForPlayout` does exactly that
      // when it reconciles a segment the output below it dropped — which puts this on the
      // default chain, not just custom sinks. The flush gate is only needed above, where we
      // *synthesize* a finish and therefore have to know the segment can no longer grow.
      const event = this.deferredFinishes.shift();
      if (event) {
        this.finishSegment(segment, event);
        continue;
      }

      if (!segment.flushed) {
        return;
      }

      if (segment.captureFailed && !segment.finishRequested && this.nextInChain) {
        // Reaching down to the wrapped output looks like a layering inversion, and normally it
        // would be. This branch only runs when the downstream output already counted the
        // segment (`acceptedDownstream`) and our capture then threw, so the sink is holding a
        // segment it will never be told about and its own `waitForPlayout` would hang. Nobody
        // else can unstick it: the frame never reached the sink's completion path. Guarded by
        // `finishRequested` so we ask exactly once.
        segment.finishRequested = true;
        this.nextInChain.onPlaybackFinished({ playbackPosition: 0, interrupted: true });
        if (!this.currentSegment) {
          // The sink also still has this segment latched open. A retried frame would silently
          // join the segment we just declared finished — the sink would never count it, so we
          // could not tell the frame had been accepted either, and the retried segment would be
          // written off as interrupted at position zero. Only safe while we hold no open segment
          // of our own; otherwise the latch belongs to a newer segment that is still growing.
          this.nextInChain.abandonOpenSegment();
        }
      }
      return;
    }

    // No segments left to attribute these to. Forwarding them to `super.onPlaybackFinished`
    // would only trip its "more finishes than segments" warning, so drop them and say so at
    // debug level instead of polluting the logs with a warning we caused.
    const leftovers = this.deferredFinishes.splice(0);
    if (leftovers.length > 0) {
      this._logger.debug(
        { count: leftovers.length },
        'discarding playback finishes with no matching recorder segment',
      );
    }
  }

  private finishSegment(segment: RecorderOutputSegment, options: PlaybackFinishedEvent): void {
    this.segments.shift();
    if (this.currentSegment === segment) {
      this.currentSegment = undefined;
      if (!segment.flushed) {
        // Settled on the sink's own finish rather than at a flush boundary, so the base class
        // still has this segment latched open. Release the latch, otherwise the next
        // `captureFrame` neither counts a new base segment nor finds one of ours to attribute
        // the frame to and throws `recorder capture has no active segment`.
        this.abandonOpenSegment();
      }
    }

    const finishTime = segment.currentPauseStart ?? Date.now();
    const trailingSilenceDuration = Math.max(0, Date.now() - finishTime);

    // Convert playbackPosition from seconds to ms for internal calculations
    let playbackPosition = options.playbackPosition * 1000;

    // Clamp playbackPosition to actual elapsed time (all in ms)
    playbackPosition = Math.max(
      0,
      Math.min(finishTime - segment.speechStartTime, playbackPosition),
    );

    // Convert back to seconds for the event
    segment.playbackEvent = { ...options, playbackPosition: playbackPosition / 1000 };
    super.onPlaybackFinished(segment.playbackEvent);

    if (!this.recorderIO.recording) {
      return;
    }

    if (segment.currentPauseStart !== undefined) {
      segment.pauseWallTimes.push([segment.currentPauseStart, finishTime]);
      segment.currentPauseStart = undefined;
    }

    if (segment.frames.length === 0) {
      this._lastSpeechEndTime = Date.now();
      return;
    }

    // pauseEvents stores (position, duration) in ms
    const pauseEvents: Array<[number, number]> = [];
    let playbackStartTime = finishTime - playbackPosition;

    if (segment.pauseWallTimes.length > 0) {
      const totalPauseDuration = segment.pauseWallTimes.reduce(
        (sum, [start, end]) => sum + (end - start),
        0,
      );
      playbackStartTime = finishTime - playbackPosition - totalPauseDuration;

      let accumulatedPause = 0;
      for (const [pauseStart, pauseEnd] of segment.pauseWallTimes) {
        let position = pauseStart - playbackStartTime - accumulatedPause;
        const duration = pauseEnd - pauseStart;
        position = Math.max(0, Math.min(position, playbackPosition));
        pauseEvents.push([position, duration]);
        accumulatedPause += duration;
      }
    }

    const buf: AudioFrame[] = [];
    let accDur = 0;
    const sampleRate = segment.frames[0]!.sampleRate;
    const numChannels = segment.frames[0]!.channels;

    let pauseIdx = 0;
    let shouldBreak = false;

    for (const frame of segment.frames) {
      let currentFrame = frame;
      const frameDuration = (frame.samplesPerChannel / frame.sampleRate) * 1000;

      if (frameDuration + accDur > playbackPosition) {
        const [left] = splitFrame(currentFrame, (playbackPosition - accDur) / 1000);
        currentFrame = left;
        shouldBreak = true;
      }

      // Process any pauses before this frame starts
      while (pauseIdx < pauseEvents.length && pauseEvents[pauseIdx]![0] <= accDur) {
        const [, pauseDur] = pauseEvents[pauseIdx]!;
        buf.push(createSilenceFrame(pauseDur, sampleRate, numChannels));
        pauseIdx++;
      }

      // Process any pauses within this frame
      const currentFrameDuration =
        (currentFrame.samplesPerChannel / currentFrame.sampleRate) * 1000;
      while (
        pauseIdx < pauseEvents.length &&
        pauseEvents[pauseIdx]![0] < accDur + currentFrameDuration
      ) {
        const [pausePos, pauseDur] = pauseEvents[pauseIdx]!;
        const [left, right] = splitFrame(currentFrame, (pausePos - accDur) / 1000);
        buf.push(left);
        accDur += (left.samplesPerChannel / left.sampleRate) * 1000;
        buf.push(createSilenceFrame(pauseDur, sampleRate, numChannels));

        currentFrame = right;
        pauseIdx++;
      }

      buf.push(currentFrame);
      accDur += (currentFrame.samplesPerChannel / currentFrame.sampleRate) * 1000;

      if (shouldBreak) {
        break;
      }
    }

    // Process remaining pauses
    while (pauseIdx < pauseEvents.length) {
      const [pausePos, pauseDur] = pauseEvents[pauseIdx]!;
      if (pausePos <= playbackPosition) {
        buf.push(createSilenceFrame(pauseDur, sampleRate, numChannels));
      }
      pauseIdx++;
    }

    // Filter out empty frames from split operations to avoid spurious buffer writes
    const filteredBuf = buf.filter((f) => f.samplesPerChannel > 0);

    if (filteredBuf.length > 0) {
      if (trailingSilenceDuration > 0) {
        filteredBuf.push(createSilenceFrame(trailingSilenceDuration, sampleRate, numChannels));
      }
      this.writeFn(filteredBuf);
    }

    this._lastSpeechEndTime = Date.now();
  }

  async captureFrame(frame: AudioFrame): Promise<void> {
    // Register our own segment BEFORE handing the frame downstream. A downstream output may
    // park this frame (ParticipantAudioOutput holds frames at its pause gate) and emit an
    // interrupted finish while it is parked. If we had not counted the segment yet, that
    // finish would arrive while we own zero segments and `AudioOutput.onPlaybackFinished`
    // would discard it as surplus — leaving the segment we register afterwards with no
    // finish left to settle it, and `waitForPlayout` stuck forever.
    const capturedBefore = this.capturedPlayoutSegments;
    const capture = super.captureFrame(frame);
    const startedNewSegment = this.capturedPlayoutSegments > capturedBefore;
    let segment = this.currentSegment;
    if (startedNewSegment) {
      const captureTime = Date.now();
      this.pauseWallTimes = this.pauseWallTimes
        .filter(([, end]) => end > captureTime)
        .map(([start, end]) => [Math.max(start, captureTime), end]);
      if (this.currentPauseStart !== undefined) {
        this.currentPauseStart = Math.max(this.currentPauseStart, captureTime);
      }

      segment = {
        frames: [],
        acceptedDownstream: this.nextInChain === undefined,
        captureFailed: false,
        capturesInFlight: 0,
        finishRequested: false,
        flushed: false,
        playoutAwaited: false,
        // Stamped here, before the frame leaves, rather than once the downstream output accepts
        // it. A downstream output may park the frame (the `ParticipantAudioOutput` pause gate)
        // and a finish can land while it is parked. `finishSegment` clamps the reported playback
        // position against `finishTime - speechStartTime`, so a timestamp taken after the park
        // would make the elapsed window ~zero (negative if we are still paused, since
        // `finishTime` is then the pause start) and truncate away every frame the sink just
        // reported as played.
        speechStartTime: captureTime,
        currentPauseStart: this.currentPauseStart,
        pauseWallTimes: [...this.pauseWallTimes],
      };
      this.segments.push(segment);
      this.currentSegment = segment;
    }
    if (!segment) {
      throw new Error('recorder capture has no active segment');
    }

    const downstreamCapturedBefore = this.nextInChain?.capturedPlayoutSegments ?? 0;
    segment.capturesInFlight++;
    let captureCompleted = false;
    try {
      await capture;
      if (this.nextInChain) {
        await this.nextInChain.captureFrame(frame);
        if (this.nextInChain.capturedPlayoutSegments > downstreamCapturedBefore) {
          segment.acceptedDownstream = true;
        }
      }

      if (this.recorderIO.recording) {
        segment.frames.push(frame);
      }

      if (this._startedWallTime === undefined) {
        this._startedWallTime = Date.now();
      }

      captureCompleted = true;
    } finally {
      if (this.nextInChain && this.nextInChain.capturedPlayoutSegments > downstreamCapturedBefore) {
        segment.acceptedDownstream = true;
      }
      if (!captureCompleted) {
        segment.captureFailed = true;
        segment.flushed = true;
        if (this.currentSegment === segment) {
          this.currentSegment = undefined;
          // We just closed this segment and `drainFinishes` reports it finished, so the base class
          // must stop counting it as open. Otherwise its capture latch is still set, the next
          // `captureFrame` neither counts a new segment nor finds one of ours to attribute the
          // frame to, and a caller that retries after a transient rejection is rejected forever.
          this.abandonOpenSegment();
        }
      }
      segment.capturesInFlight--;
      this.drainFinishes();
    }
  }

  /**
   * Wait for the segment that is open at call time to finish playing.
   *
   * Unlike the base {@link AudioOutput}, this resolves with *that segment's* own
   * `playbackEvent` rather than whatever `lastPlaybackEvent` happens to hold when the wait
   * unblocks. With multiple segments in flight the base behavior can hand a caller another
   * segment's event — e.g. report `interrupted: true` for a segment that played to completion.
   * This is a deliberate divergence from the base class (and from Python, whose
   * `voice/io.py` also returns the last event). Note the `playedOwnFrame` bookkeeping in
   * `agent_activity.ts` exists precisely to work around stale events from waits like this one,
   * so it is now partly redundant here; it is left in place because it still guards the other
   * outputs. Giving the base class the same per-segment attribution — which would also fix
   * `ParticipantAudioOutput` — is follow-up work.
   *
   * This also blocks while a frame is still in flight inside the wrapped output, where the
   * pre-refactor code returned immediately with a fabricated
   * `{ playbackPosition: 0, interrupted: false }` — the base class default, reachable only
   * because the segment had not been registered yet. Registering before forwarding is what
   * makes a finish arriving during that window attributable at all, so the wait necessarily
   * sees the segment; reporting a turn as completed while its audio has not reached the sink
   * would be the wrong answer anyway.
   */
  async waitForPlayout(): Promise<PlaybackFinishedEvent> {
    const targetSegment = this.segments[this.segments.length - 1];
    const waitForRecorder = super.waitForPlayout();
    if (this.nextInChain) {
      await this.nextInChain.waitForPlayout();
    }
    if (targetSegment) {
      // Marked only after the wrapped output's own wait returns, so this really does mean
      // "nothing downstream is still holding this segment" and not merely "someone asked".
      // Only the segment open at call time is marked: one opened later is not part of what
      // this caller is waiting for, and settling it early would split the recording.
      targetSegment.playoutAwaited = true;
    }
    this.drainFinishes();
    const event = await waitForRecorder;
    return targetSegment?.playbackEvent ?? event;
  }

  /**
   * Mark the currently open segment as flushed because no more frames can arrive for it.
   *
   * Called by {@link RecorderIO.close}. Unlike {@link flush} this does not notify the base class
   * or the wrapped output — closing is not a segment boundary they need to hear about, it just
   * means our own segment can never grow again, which is the guarantee `drainFinishes` needs
   * before it may settle a segment the downstream output never accepted. A segment with a
   * capture still in flight is unaffected: `drainFinishes` continues to hold it.
   */
  _sealOpenSegment(): void {
    if (this.currentSegment) {
      this.currentSegment.flushed = true;
      this.currentSegment = undefined;
    }
    this.drainFinishes();
  }

  flush(): void {
    super.flush();
    if (this.currentSegment) {
      this.currentSegment.flushed = true;
      this.currentSegment = undefined;
    }

    if (this.nextInChain) {
      this.nextInChain.flush();
    }
    this.drainFinishes();
  }

  clearBuffer(): void {
    if (this.nextInChain) {
      this.nextInChain.clearBuffer();
    }
  }
}

/**
 * Split an audio frame at the given position (in seconds)
 * Returns [left, right] frames
 */
function splitFrame(frame: AudioFrame, position: number): [AudioFrame, AudioFrame] {
  if (position <= 0) {
    const emptyFrame = new AudioFrame(new Int16Array(0), frame.sampleRate, frame.channels, 0);
    return [emptyFrame, frame];
  }

  const frameDuration = frame.samplesPerChannel / frame.sampleRate;
  if (position >= frameDuration) {
    const emptyFrame = new AudioFrame(new Int16Array(0), frame.sampleRate, frame.channels, 0);
    return [frame, emptyFrame];
  }

  // samplesNeeded is samples per channel (i.e., sample count in time)
  const samplesNeeded = Math.min(Math.floor(position * frame.sampleRate), frame.samplesPerChannel);
  // Int16Array: each element is one sample, interleaved by channel
  // So total elements = samplesPerChannel * channels
  const numChannels = frame.channels;

  const leftData = frame.data.slice(0, samplesNeeded * numChannels);
  const rightData = frame.data.slice(samplesNeeded * numChannels);

  const leftFrame = new AudioFrame(leftData, frame.sampleRate, frame.channels, samplesNeeded);

  const rightFrame = new AudioFrame(
    rightData,
    frame.sampleRate,
    frame.channels,
    frame.samplesPerChannel - samplesNeeded,
  );

  return [leftFrame, rightFrame];
}
