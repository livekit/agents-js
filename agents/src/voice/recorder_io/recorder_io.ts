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
import {
  AudioInput,
  AudioOutput,
  type PlaybackFinishedEvent,
  type PlaybackProgressedEvent,
} from '../io.js';

configureFfmpeg();

// Both channels sit on one absolute timeline: the user's audio where it arrived, the agent's
// where the device reports it played. Silence is whatever nothing was written over.

export const WRITE_INTERVAL_MS = 2500;
const DEFAULT_SAMPLE_RATE = 48000;
const CLOSE_PLAYOUT_FLUSH_TIMEOUT_MS = 2000;

/** How long the writer waits on a source that stopped delivering before taking the silence as real. */
export const INPUT_STALL_TIMEOUT_MS = 1000;

/**
 * A run continues while its own clock stays this close to the timestamps coming in; re-anchoring
 * beyond it keeps a drifting capture clock from sliding the channel.
 */
const RESYNC_TOLERANCE_MS = 100;

export interface RecorderOptions {
  agentSession: AgentSession;
  sampleRate?: number;
}

type QueueItem =
  | { kind: 'captured'; channel: 0 | 1; startedAt: number; frame: AudioFrame }
  | { kind: 'flush'; until: number };

/** One channel of the recording, holding runs of audio placed on the absolute timeline. */
export class Track {
  /** Placed runs, each a mono float32 block starting at an absolute sample index. */
  private placed: Array<{ start: number; samples: Float32Array }> = [];
  private resampler?: AudioResampler;
  private sourceRate?: number;
  private runStart?: number;
  private runSamples: number = 0;
  droppedSamples: number = 0;

  constructor(
    private readonly sampleRate: number,
    private readonly t0: number,
  ) {}

  /** Mono frames at the recording rate, of which the resampler may still hold some back. */
  private resample(frame: AudioFrame): AudioFrame[] {
    let mono = frame.data;
    if (frame.channels > 1) {
      mono = new Int16Array(frame.samplesPerChannel);
      for (let i = 0; i < frame.samplesPerChannel; i++) {
        let sum = 0;
        for (let ch = 0; ch < frame.channels; ch++) {
          sum += frame.data[i * frame.channels + ch]!;
        }
        mono[i] = Math.round(sum / frame.channels);
      }
    }

    const monoFrame = new AudioFrame(mono, frame.sampleRate, 1, frame.samplesPerChannel);
    if (frame.sampleRate === this.sampleRate) {
      return [monoFrame];
    }

    if (!this.resampler || this.sourceRate !== frame.sampleRate) {
      this.resampler?.close();
      this.sourceRate = frame.sampleRate;
      this.resampler = new AudioResampler(frame.sampleRate, this.sampleRate, 1);
    }

    return this.resampler.push(monoFrame);
  }

  /** Append resampled audio to the open run, which begins at `runStart`. */
  private place(frames: AudioFrame[]): void {
    if (frames.length === 0) {
      return;
    }

    const total = frames.reduce((count, frame) => count + frame.samplesPerChannel, 0);
    const samples = new Float32Array(total);
    let pos = 0;
    for (const frame of frames) {
      for (let i = 0; i < frame.samplesPerChannel; i++) {
        samples[pos++] = frame.data[i]! / 32768;
      }
    }

    const start =
      Math.round(((this.runStart! - this.t0) / 1000) * this.sampleRate) + this.runSamples;
    this.placed.push({ start, samples });
    this.runSamples += total;
  }

  /** Add audio that began at `startedAt`, extending the open run where it fits. */
  push(startedAt: number, frame: AudioFrame): void {
    const expected =
      this.runStart === undefined
        ? undefined
        : this.runStart + (this.runSamples / this.sampleRate) * 1000;

    if (expected === undefined || Math.abs(startedAt - expected) > RESYNC_TOLERANCE_MS) {
      if (this.resampler) {
        // whatever the resampler still holds is the tail of the run that just ended
        this.place(this.resampler.flush());
      }
      this.runStart = startedAt;
      this.runSamples = 0;
    }

    this.place(this.resample(frame));
  }

  /** The channel over `[start, end)`, silent wherever nothing was placed. */
  take(start: number, end: number): Float32Array {
    const block = new Float32Array(Math.max(0, end - start));
    const keep: Array<{ start: number; samples: Float32Array }> = [];

    for (const run of this.placed) {
      const stop = run.start + run.samples.length;
      if (stop <= start) {
        this.droppedSamples += run.samples.length;
        continue;
      }
      if (run.start >= end) {
        keep.push(run);
        continue;
      }

      const lo = Math.max(run.start, start);
      const hi = Math.min(stop, end);
      for (let i = lo; i < hi; i++) {
        block[i - start]! += run.samples[i - run.start]!;
      }
      if (stop > end) {
        keep.push({ start: end, samples: run.samples.subarray(end - run.start) });
      }
    }

    this.placed = keep;
    return block;
  }

  close(): void {
    this.resampler?.close();
  }
}

export class RecorderIO {
  private inRecord?: RecorderAudioInput;
  private outRecord?: RecorderAudioOutput;

  private chan: StreamChannel<QueueItem> = createStreamChannel<QueueItem>();

  private session: AgentSession;
  private sampleRate: number;

  private _outputPath?: string;
  private writeTask?: Task<void>;
  private encodeTask?: Task<void>;

  private closeFuture: Future<void> = new Future();
  private lock: Mutex = new Mutex();
  private started: boolean = false;
  private closing: boolean = false;
  private closePlayoutFlushTimeoutMs: number = CLOSE_PLAYOUT_FLUSH_TIMEOUT_MS;

  /** Zero of the absolute timeline both channels are placed on. */
  private t0?: number;
  /** Wall time up to which the user channel has delivered everything it is going to. */
  private inputSettled: number = 0;

  // FFmpeg streaming state
  private pcmStream?: PassThrough;
  private ffmpegPromise?: Promise<void>;

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
      this.t0 = this.inputSettled = Date.now();

      // Ensure output directory exists
      const dir = path.dirname(outputPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      this.writeTask = Task.from(({ signal }) => this.write(signal));
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

      if (this.writeTask) {
        await cancelAndWait([this.writeTask]);
        this.writeTask = undefined;
      }

      // Everything up to now is settled, so the recording keeps its tail instead of dropping it.
      try {
        await this.chan.write({ kind: 'flush', until: Date.now() });
      } catch (err) {
        if (!isWritableStreamClosedError(err)) {
          this.logger.error({ err }, 'Error writing the final RecorderIO flush');
        }
      }

      await this.chan.close();
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
    this.inRecord = new RecorderAudioInput(this, audioInput, (startedAt, frame) => {
      // a contiguous stream, so what has arrived is exactly what is settled
      this.inputSettled = startedAt + (frame.samplesPerChannel / frame.sampleRate) * 1000;
      this.enqueue({ kind: 'captured', channel: 0, startedAt, frame });
    });
    return this.inRecord;
  }

  recordOutput(audioOutput: AudioOutput): RecorderAudioOutput {
    this.outRecord = new RecorderAudioOutput(this, audioOutput, (startedAt, frame) =>
      this.enqueue({ kind: 'captured', channel: 1, startedAt, frame }),
    );
    return this.outRecord;
  }

  private enqueue(item: QueueItem): void {
    if (!this.started || this.closing || this.chan.closed) {
      return;
    }

    this.chan.write(item).catch((err) => {
      if (!isWritableStreamClosedError(err)) {
        this.logger.error({ err }, 'Error writing to the RecorderIO queue');
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
    return this.t0;
  }

  /**
   * Write task: settle the timeline up to the last moment both channels can account for
   */
  private async write(signal: AbortSignal): Promise<void> {
    while (!signal.aborted && this.started && !this.closing) {
      try {
        await delay(WRITE_INTERVAL_MS, { signal });
      } catch {
        // Aborted
        break;
      }

      // a source gone quiet would hold the writer forever, so it is only waited on so long
      let settled = Math.max(this.inputSettled, Date.now() - INPUT_STALL_TIMEOUT_MS);
      const pendingSince = this.outRecord!.pendingSince;
      if (pendingSince !== undefined) {
        // a segment in flight has not said where its audio went
        settled = Math.min(settled, pendingSince);
      }

      this.enqueue({ kind: 'flush', until: settled });
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
   * Interleave one settled block of both channels and stream it to FFmpeg
   */
  private writePCM(left: Float32Array, right: Float32Array): void {
    if (left.length === 0) return;

    if (!this.pcmStream) {
      this.startFFmpeg();
    }

    const stereoData = new Int16Array(left.length * 2);
    for (let i = 0; i < left.length; i++) {
      stereoData[i * 2] = Math.max(-32768, Math.min(32767, Math.round(left[i]! * 32768)));
      stereoData[i * 2 + 1] = Math.max(-32768, Math.min(32767, Math.round(right[i]! * 32768)));
    }

    this.pcmStream!.write(Buffer.from(stereoData.buffer));
  }

  /**
   * Encode task: place audio on the timeline, then hand each settled window to FFmpeg
   */
  private async encode(): Promise<void> {
    if (!this._outputPath || this.t0 === undefined) return;

    const tracks = [new Track(this.sampleRate, this.t0), new Track(this.sampleRate, this.t0)];
    let cursor = 0;
    const reader = this.chan.stream().getReader();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        if (value.kind === 'captured') {
          tracks[value.channel]!.push(value.startedAt, value.frame);
          continue;
        }

        const end = Math.round(((value.until - this.t0) / 1000) * this.sampleRate);
        if (end <= cursor) continue;

        this.writePCM(tracks[0]!.take(cursor, end), tracks[1]!.take(cursor, end));
        cursor = end;
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
        reader.releaseLock();
        for (const [channel, track] of [
          ['input', tracks[0]!],
          ['output', tracks[1]!],
        ] as const) {
          if (track.droppedSamples) {
            this.logger.warn(
              { channel, samples: track.droppedSamples },
              'recorder dropped audio that reached it after its place in the timeline had been written',
            );
          }
          track.close();
        }
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
  private onFrame: (startedAt: number, frame: AudioFrame) => void;

  constructor(
    recorderIO: RecorderIO,
    source: AudioInput,
    onFrame: (startedAt: number, frame: AudioFrame) => void,
  ) {
    super();
    this.recorderIO = recorderIO;
    this.source = source;
    this.onFrame = onFrame;

    // Set up the intercepting stream
    this.multiStream.addInputStream(this.createInterceptingStream());
  }

  /**
   * Creates a stream that intercepts frames from the source,
   * hands them to the recorder when recording, and passes them through unchanged.
   */
  private createInterceptingStream(): ReadableStream<AudioFrame> {
    const sourceStream = this.source.stream;
    const reader = sourceStream.getReader();

    const transform = new TransformStream<AudioFrame, AudioFrame>({
      transform: (frame, controller) => {
        if (this.recorderIO.recording) {
          // frames carry no capture timestamp, so arrival is the clock
          const duration = (frame.samplesPerChannel / frame.sampleRate) * 1000;
          this.onFrame(Date.now() - duration, frame);
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
  /** The segment's frames joined, built on the first slice and dropped by the next capture. */
  pcm?: Int16Array;
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
  segmentSince: number;
  /** When the sink said this segment began to play, if it said so at all. */
  startedAt?: number;
  /** Whether the sink reported where any of this segment's audio went. */
  reported: boolean;
}

class RecorderAudioOutput extends AudioOutput {
  private recorderIO: RecorderIO;
  private onPlayed: (startedAt: number, frame: AudioFrame) => void;
  private segments: RecorderOutputSegment[] = [];
  private currentSegment?: RecorderOutputSegment;
  private deferredFinishes: PlaybackFinishedEvent[] = [];
  private _logger = log();

  constructor(
    recorderIO: RecorderIO,
    audioOutput: AudioOutput,
    onPlayed: (startedAt: number, frame: AudioFrame) => void,
  ) {
    super(audioOutput.sampleRate, audioOutput, { pause: true });
    this.recorderIO = recorderIO;
    this.onPlayed = onPlayed;
  }

  get hasPendingData(): boolean {
    return this.segments.some((segment) => segment.frames.length > 0);
  }

  /** Wall time from which the agent channel is unsettled, while a segment is in flight. */
  get pendingSince(): number | undefined {
    return this.segments[0]?.segmentSince;
  }

  onPlaybackStarted(createdAt: number): void {
    super.onPlaybackStarted(createdAt);

    const segment = this.segments[0];
    if (segment && segment.startedAt === undefined) {
      segment.startedAt = createdAt;
    }
  }

  onPlaybackProgressed(ev: PlaybackProgressedEvent): void {
    super.onPlaybackProgressed(ev);

    // A report describes the audio playing now, which belongs to the oldest segment we have not
    // settled — the same attribution `drainFinishes` gives a finish.
    const segment = this.segments[0];
    if (segment && this.recorderIO.recording) {
      segment.reported = true;
      this.place(segment, ev.startedAt, ev.offset, ev.duration);
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

    segment.playbackEvent = options;
    super.onPlaybackFinished(options);

    if (!this.recorderIO.recording || segment.reported) {
      return;
    }

    // the sink reports nothing of its own, so its endpoints describe the segment
    const playbackPosition = options.playbackPosition * 1000;
    this.place(segment, segment.startedAt ?? Date.now() - playbackPosition, 0, playbackPosition);
  }

  /** Hand the recorder the captured audio a report covers, at the time it played. */
  private place(
    segment: RecorderOutputSegment,
    startedAt: number,
    offset: number,
    duration: number,
  ): void {
    if (segment.frames.length === 0 || duration <= 0) {
      return;
    }

    const { sampleRate, channels } = segment.frames[0]!;
    if (!segment.pcm) {
      const pcm = new Int16Array(
        segment.frames.reduce((count, frame) => count + frame.data.length, 0),
      );
      let pos = 0;
      for (const frame of segment.frames) {
        pcm.set(frame.data, pos);
        pos += frame.data.length;
      }
      segment.pcm = pcm;
    }

    const lo = Math.round((offset / 1000) * sampleRate) * channels;
    const hi = Math.min(
      Math.round(((offset + duration) / 1000) * sampleRate) * channels,
      segment.pcm.length,
    );
    if (hi <= lo) {
      return;
    }

    const chunk = segment.pcm.slice(lo, hi);
    this.onPlayed(startedAt, new AudioFrame(chunk, sampleRate, channels, chunk.length / channels));
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
      segment = {
        frames: [],
        acceptedDownstream: this.nextInChain === undefined,
        captureFailed: false,
        capturesInFlight: 0,
        finishRequested: false,
        flushed: false,
        playoutAwaited: false,
        reported: false,
        // Stamped here, before the frame leaves, rather than once the downstream output accepts
        // it. A downstream output may park the frame (the `ParticipantAudioOutput` pause gate),
        // and the recorder holds the timeline open from this moment: audio that is about to play
        // must not be written off as silence while the sink is still deciding where it went.
        segmentSince: Date.now(),
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
        segment.pcm = undefined;
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
