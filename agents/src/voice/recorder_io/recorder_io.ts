// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import { Mutex } from '@livekit/mutex';
import { AudioFrame, AudioResampler } from '@livekit/rtc-node';
import ffmpeg from 'fluent-ffmpeg';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { ReadableStream } from 'node:stream/web';
import { TransformStream } from 'node:stream/web';
import { log } from '../../log.js';
import { isStreamReaderReleaseError } from '../../stream/deferred_stream.js';
import { type StreamChannel, createStreamChannel } from '../../stream/stream_channel.js';
import { Future, Task, cancelAndWait, delay } from '../../utils.js';
import type { AgentSession } from '../agent_session.js';
import { AudioInput, AudioOutput, type PlaybackFinishedEvent } from '../io.js';

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const WRITE_INTERVAL_MS = 2500;
const DEFAULT_SAMPLE_RATE = 48000;

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

      await this.inChan.close();
      await this.outChan.close();
      await this.closeFuture.await;
      await cancelAndWait([this.forwardTask!, this.encodeTask!]);

      this.started = false;
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
    const inputBuf = this.inRecord!.takeBuf(this.outRecord?._lastSpeechEndTime);
    this.inChan.write(inputBuf);
    this.outChan.write(buf);
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
    while (!signal.aborted) {
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
      this.inChan
        .write(inputBuf)
        .catch((err) => this.logger.error({ err }, 'Error writing RecorderIO input buffer'));
      this.outChan
        .write([])
        .catch((err) => this.logger.error({ err }, 'Error writing RecorderIO output buffer'));
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
          if (
            err.message?.includes('Output stream closed') ||
            err.message?.includes('received signal 2') ||
            err.message?.includes('SIGKILL') ||
            err.message?.includes('SIGINT')
          ) {
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
      inReader.releaseLock();
      outReader.releaseLock();

      if (!this.closeFuture.done) {
        this.closeFuture.resolve();
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
    this.deferredStream.setSource(this.createInterceptingStream());
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
      frames = [
        createSilenceFrame(padding / 1000, firstFrame.sampleRate, firstFrame.channels),
        ...frames,
      ];
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

  onAttached(): void {
    this.source.onAttached();
  }

  onDetached(): void {
    this.source.onDetached();
  }
}

class RecorderAudioOutput extends AudioOutput {
  private recorderIO: RecorderIO;
  private writeFn: (buf: AudioFrame[]) => void;
  private accFrames: AudioFrame[] = [];
  private _startedWallTime?: number;
  private _logger = log();

  _lastSpeechEndTime?: number;
  private _lastSpeechStartTime?: number;

  // Pause tracking
  private currentPauseStart?: number;
  private pauseWallTimes: Array<[number, number]> = []; // [start, end] pairs

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
    return this.accFrames.length > 0;
  }

  pause(): void {
    if (this.currentPauseStart === undefined && this.recorderIO.recording) {
      this.currentPauseStart = Date.now();
    }

    if (this.nextInChain) {
      this.nextInChain.pause();
    }
  }

  /**
   * Resume playback and record the pause interval
   */
  resume(): void {
    if (this.currentPauseStart !== undefined && this.recorderIO.recording) {
      this.pauseWallTimes.push([this.currentPauseStart, Date.now()]);
      this.currentPauseStart = undefined;
    }

    if (this.nextInChain) {
      this.nextInChain.resume();
    }
  }

  private resetPauseState(): void {
    this.currentPauseStart = undefined;
    this.pauseWallTimes = [];
  }

  onPlaybackFinished(options: PlaybackFinishedEvent): void {
    const finishTime = this.currentPauseStart ?? Date.now();
    const trailingSilenceDuration = Math.max(0, Date.now() - finishTime);

    // Convert playbackPosition from seconds to ms for internal calculations
    let playbackPosition = options.playbackPosition * 1000;

    if (this._lastSpeechStartTime === undefined) {
      this._logger.warn(
        {
          finishTime,
          playbackPosition,
          interrupted: options.interrupted,
        },
        'playback finished before speech started',
      );
      playbackPosition = 0;
    }

    // Clamp playbackPosition to actual elapsed time (all in ms)
    playbackPosition = Math.max(
      0,
      Math.min(finishTime - (this._lastSpeechStartTime ?? 0), playbackPosition),
    );

    // Convert back to seconds for the event
    super.onPlaybackFinished({ ...options, playbackPosition: playbackPosition / 1000 });

    if (!this.recorderIO.recording) {
      return;
    }

    if (this.currentPauseStart !== undefined) {
      this.pauseWallTimes.push([this.currentPauseStart, finishTime]);
      this.currentPauseStart = undefined;
    }

    if (this.accFrames.length === 0) {
      this.resetPauseState();
      this._lastSpeechEndTime = Date.now();
      this._lastSpeechStartTime = undefined;
      return;
    }

    // pauseEvents stores (position, duration) in ms
    const pauseEvents: Array<[number, number]> = [];
    let playbackStartTime = finishTime - playbackPosition;

    if (this.pauseWallTimes.length > 0) {
      const totalPauseDuration = this.pauseWallTimes.reduce(
        (sum, [start, end]) => sum + (end - start),
        0,
      );
      playbackStartTime = finishTime - playbackPosition - totalPauseDuration;

      let accumulatedPause = 0;
      for (const [pauseStart, pauseEnd] of this.pauseWallTimes) {
        let position = pauseStart - playbackStartTime - accumulatedPause;
        const duration = pauseEnd - pauseStart;
        position = Math.max(0, Math.min(position, playbackPosition));
        pauseEvents.push([position, duration]);
        accumulatedPause += duration;
      }
    }

    const buf: AudioFrame[] = [];
    let accDur = 0;
    const sampleRate = this.accFrames[0]!.sampleRate;
    const numChannels = this.accFrames[0]!.channels;

    let pauseIdx = 0;
    let shouldBreak = false;

    for (const frame of this.accFrames) {
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
        buf.push(createSilenceFrame(pauseDur / 1000, sampleRate, numChannels));
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
        buf.push(createSilenceFrame(pauseDur / 1000, sampleRate, numChannels));

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
        buf.push(createSilenceFrame(pauseDur / 1000, sampleRate, numChannels));
      }
      pauseIdx++;
    }

    if (buf.length > 0) {
      if (trailingSilenceDuration > 0) {
        buf.push(createSilenceFrame(trailingSilenceDuration / 1000, sampleRate, numChannels));
      }
      this.writeFn(buf);
    }

    this.accFrames = [];
    this.resetPauseState();
    this._lastSpeechEndTime = Date.now();
    this._lastSpeechStartTime = undefined;
  }

  async captureFrame(frame: AudioFrame): Promise<void> {
    if (this.nextInChain) {
      await this.nextInChain.captureFrame(frame);
    }

    await super.captureFrame(frame);

    if (this.recorderIO.recording) {
      this.accFrames.push(frame);
    }

    if (this._startedWallTime === undefined) {
      this._startedWallTime = Date.now();
    }

    if (this._lastSpeechStartTime === undefined) {
      this._lastSpeechStartTime = Date.now();
    }
  }

  flush(): void {
    super.flush();

    if (this.nextInChain) {
      this.nextInChain.flush();
    }
  }

  clearBuffer(): void {
    if (this.nextInChain) {
      this.nextInChain.clearBuffer();
    }
  }
}

/**
 * Create a silent audio frame with the given duration
 */
function createSilenceFrame(
  durationInS: number,
  sampleRate: number,
  numChannels: number,
): AudioFrame {
  const samples = Math.floor(durationInS * sampleRate);
  const data = new Int16Array(samples * numChannels); // Zero-filled by default
  return new AudioFrame(data, sampleRate, numChannels, samples);
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
  const samplesNeeded = Math.floor(position * frame.sampleRate);
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
