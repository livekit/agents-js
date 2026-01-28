// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AudioFrame } from '@livekit/rtc-node';
import type { ReadableStream, WritableStreamDefaultWriter } from 'node:stream/web';
import { log } from '../../log.js';
import { IdentityTransform } from '../../stream/identity_transform.js';
import type { SentenceStream, SentenceTokenizer } from '../../tokenize/index.js';
import { basic } from '../../tokenize/index.js';
import { Future, Task, delay } from '../../utils.js';
import {
  AudioOutput,
  type PlaybackFinishedEvent,
  TextOutput,
  type TimedString,
  isTimedString,
} from '../io.js';

const STANDARD_SPEECH_RATE = 3.83; // hyphens (syllables) per second

interface TextSyncOptions {
  speed: number;
  hyphenateWord: (word: string) => string[];
  splitWords: (words: string) => [string, number, number][];
  sentenceTokenizer: SentenceTokenizer;
}

interface TextData {
  sentenceStream: SentenceStream;
  pushedText: string;
  done: boolean;
  forwardedHyphens: number;
  forwardedText: string;
}

/**
 * Tracks speaking rate data from TTS timing annotations.
 * @internal Exported for testing purposes.
 */
export class SpeakingRateData {
  /** Timestamps of the speaking rate. */
  timestamps: number[] = [];
  /** Speed at the timestamp. */
  speakingRate: number[] = [];
  /** Accumulated speaking units up to the timestamp. */
  speakIntegrals: number[] = [];
  /** Buffer for text without timing annotations yet. */
  private textBuffer: string[] = [];

  /**
   * Add by speaking rate estimation.
   */
  addByRate(timestamp: number, speakingRate: number): void {
    const integral =
      this.speakIntegrals.length > 0 ? this.speakIntegrals[this.speakIntegrals.length - 1]! : 0;
    const dt = timestamp - this.pushedDuration;
    const newIntegral = integral + speakingRate * dt;

    this.timestamps.push(timestamp);
    this.speakingRate.push(speakingRate);
    this.speakIntegrals.push(newIntegral);
  }

  /**
   * Add annotation from TimedString with start_time/end_time.
   */
  addByAnnotation(text: string, startTime: number | undefined, endTime: number | undefined): void {
    if (startTime !== undefined) {
      // Calculate the integral of the speaking rate up to the start time
      const integral =
        this.speakIntegrals.length > 0 ? this.speakIntegrals[this.speakIntegrals.length - 1]! : 0;

      const dt = startTime - this.pushedDuration;
      // Use the length of the text directly instead of hyphens
      const textLen = this.textBuffer.reduce((sum, t) => sum + t.length, 0);
      const newIntegral = integral + textLen;
      const rate = dt > 0 ? textLen / dt : 0;

      this.timestamps.push(startTime);
      this.speakingRate.push(rate);
      this.speakIntegrals.push(newIntegral);
      this.textBuffer = [];
    }

    this.textBuffer.push(text);

    if (endTime !== undefined) {
      this.addByAnnotation('', endTime, undefined);
    }
  }

  /**
   * Get accumulated speaking units up to the given timestamp.
   */
  accumulateTo(timestamp: number): number {
    if (this.timestamps.length === 0) {
      return 0;
    }

    // Binary search for the right position (equivalent to np.searchsorted with side="right")
    let idx = 0;
    for (let i = 0; i < this.timestamps.length; i++) {
      if (this.timestamps[i]! <= timestamp) {
        idx = i + 1;
      } else {
        break;
      }
    }

    if (idx === 0) {
      return 0;
    }

    let integralT = this.speakIntegrals[idx - 1]!;

    // Fill the tail assuming the speaking rate is constant
    const dt = timestamp - this.timestamps[idx - 1]!;
    const rate =
      idx < this.speakingRate.length ? this.speakingRate[idx]! : this.speakingRate[idx - 1]!;
    integralT += rate * dt;

    // If there is a next timestamp, make sure the integral does not exceed the next
    if (idx < this.timestamps.length) {
      integralT = Math.min(integralT, this.speakIntegrals[idx]!);
    }

    return integralT;
  }

  /** Get the last pushed timestamp. */
  get pushedDuration(): number {
    return this.timestamps.length > 0 ? this.timestamps[this.timestamps.length - 1]! : 0;
  }
}

interface AudioData {
  pushedDuration: number;
  done: boolean;
  annotatedRate: SpeakingRateData | null;
}

class SegmentSynchronizerImpl {
  private textData: TextData;
  private audioData: AudioData;
  private speed: number;
  private outputStream: IdentityTransform<string>;
  private outputStreamWriter: WritableStreamDefaultWriter<string>;
  private captureTask: Promise<void>;
  private startWallTime?: number;

  private startFuture: Future = new Future();
  private closedFuture: Future = new Future();
  private playbackCompleted: boolean = false;

  private logger = log();

  constructor(
    private readonly options: TextSyncOptions,
    private readonly nextInChain: TextOutput,
  ) {
    this.speed = options.speed * STANDARD_SPEECH_RATE; // hyphens per second
    this.textData = {
      sentenceStream: options.sentenceTokenizer.stream(),
      pushedText: '',
      done: false,
      forwardedHyphens: 0,
      forwardedText: '',
    };
    this.audioData = {
      pushedDuration: 0,
      done: false,
      annotatedRate: null,
    };
    this.outputStream = new IdentityTransform();
    this.outputStreamWriter = this.outputStream.writable.getWriter();

    this.mainTask()
      .then(() => {
        this.outputStreamWriter.close();
      })
      .catch((error) => {
        this.logger.error({ error }, 'mainTask SegmentSynchronizerImpl');
      });
    this.captureTask = this.captureTaskImpl();
  }

  get closed() {
    return this.closedFuture.done;
  }

  get audioInputEnded() {
    return this.audioData.done;
  }

  get textInputEnded() {
    return this.textData.done;
  }

  get hasPendingText(): boolean {
    return this.textData.pushedText.length > this.textData.forwardedText.length;
  }

  get readable(): ReadableStream<string> {
    return this.outputStream.readable;
  }

  pushAudio(frame: AudioFrame) {
    if (this.closed) {
      this.logger.warn('SegmentSynchronizerImpl.pushAudio called after close');
      return;
    }
    // TODO(AJS-102): use frame.durationMs once available in rtc-node
    const frameDuration = frame.samplesPerChannel / frame.sampleRate;

    if (!this.startWallTime && frameDuration > 0) {
      this.startWallTime = Date.now();
      this.startFuture.resolve();
    }

    this.audioData.pushedDuration += frameDuration;
  }

  endAudioInput() {
    if (this.closed) {
      this.logger.warn('SegmentSynchronizerImpl.endAudioInput called after close');
      return;
    }

    this.audioData.done = true;
  }

  pushText(text: string | TimedString) {
    if (this.closed) {
      this.logger.warn('SegmentSynchronizerImpl.pushText called after close');
      return;
    }

    // Check if text is a TimedString (has timing information)
    let textStr: string;
    let startTime: number | undefined;
    let endTime: number | undefined;

    if (isTimedString(text)) {
      // This is a TimedString
      textStr = text.text;
      startTime = text.startTime;
      endTime = text.endTime;

      // Create annotatedRate if it doesn't exist
      if (!this.audioData.annotatedRate) {
        this.audioData.annotatedRate = new SpeakingRateData();
      }

      // Add the timing annotation
      this.audioData.annotatedRate.addByAnnotation(textStr, startTime, endTime);
    } else {
      textStr = text;
    }

    this.textData.sentenceStream.pushText(textStr);
    this.textData.pushedText += textStr;
  }

  endTextInput() {
    if (this.closed) {
      this.logger.warn('SegmentSynchronizerImpl.endTextInput called after close');
      return;
    }

    this.textData.done = true;
    this.textData.sentenceStream.endInput();
  }

  markPlaybackFinished(_playbackPosition: number, interrupted: boolean) {
    if (this.closed) {
      this.logger.warn('SegmentSynchronizerImpl.markPlaybackFinished called after close');
      return;
    }

    if (!this.textData.done || !this.audioData.done) {
      this.logger.warn(
        { textDone: this.textData.done, audioDone: this.audioData.done },
        'SegmentSynchronizerImpl.markPlaybackFinished called before text/audio input is done',
      );
      // This allows mainTask to flush remaining text even if audio wasn't formally ended
      if (!interrupted) {
        this.playbackCompleted = true;
      }
      return;
    }

    if (!interrupted) {
      this.playbackCompleted = true;
    }
  }

  get synchronizedTranscript(): string {
    if (this.playbackCompleted) {
      return this.textData.pushedText;
    }
    return this.textData.forwardedText;
  }

  private async captureTaskImpl() {
    // Don't use a for-await loop here, because exiting the loop will close the writer in the
    // outputStream, which will cause an error in the mainTask.then method.
    // NOTE: forwardedText is updated in mainTask, NOT here
    const reader = this.outputStream.readable.getReader();
    while (true) {
      const { done, value: text } = await reader.read();
      if (done) {
        break;
      }
      await this.nextInChain.captureText(text);
    }
    reader.releaseLock();
    this.nextInChain.flush();
  }

  private async mainTask(): Promise<void> {
    await this.startFuture.await;

    if (this.closed && !this.playbackCompleted) {
      return;
    }

    if (!this.startWallTime) {
      throw new Error('startWallTime is not set when starting SegmentSynchronizerImpl.mainTask');
    }

    for await (const textSegment of this.textData.sentenceStream) {
      const sentence = textSegment.token;

      let textCursor = 0;
      if (this.closed && !this.playbackCompleted) {
        return;
      }

      for (const [word, _, endPos] of this.options.splitWords(sentence)) {
        if (this.closed && !this.playbackCompleted) {
          return;
        }

        if (this.playbackCompleted) {
          this.outputStreamWriter.write(sentence.slice(textCursor, endPos));
          textCursor = endPos;
          continue;
        }

        const wordHphens = this.options.hyphenateWord(word).length;
        const elapsedSeconds = (Date.now() - this.startWallTime) / 1000;

        let dHyphens = 0;
        const annotated = this.audioData.annotatedRate;

        if (annotated && annotated.pushedDuration >= elapsedSeconds) {
          // Use actual TTS timing annotations for accurate sync
          const targetLen = Math.floor(annotated.accumulateTo(elapsedSeconds));
          const forwardedLen = this.textData.forwardedText.length;

          if (targetLen >= forwardedLen) {
            const dText = this.textData.pushedText.slice(forwardedLen, targetLen);
            dHyphens = this.calcHyphens(dText).length;
          } else {
            const dText = this.textData.pushedText.slice(targetLen, forwardedLen);
            dHyphens = -this.calcHyphens(dText).length;
          }
        } else {
          // Fall back to estimated hyphens-per-second calculation
          const targetHyphens = elapsedSeconds * this.options.speed;
          dHyphens = Math.max(0, targetHyphens - this.textData.forwardedHyphens);
        }

        let delayTime = Math.max(0, wordHphens - dHyphens) / this.speed;

        if (this.playbackCompleted) {
          delayTime = 0;
        }

        await this.sleepIfNotClosed(delayTime / 2);
        const forwardedWord = sentence.slice(textCursor, endPos);
        this.outputStreamWriter.write(forwardedWord);

        await this.sleepIfNotClosed(delayTime / 2);

        this.textData.forwardedHyphens += wordHphens;
        this.textData.forwardedText += forwardedWord;
        textCursor = endPos;
      }

      if (textCursor < sentence.length) {
        const remaining = sentence.slice(textCursor);
        this.outputStreamWriter.write(remaining);
      }
    }
  }

  private calcHyphens(text: string): string[] {
    const words = this.options.splitWords(text);
    const hyphens: string[] = [];
    for (const [word] of words) {
      hyphens.push(...this.options.hyphenateWord(word));
    }
    return hyphens;
  }

  private async sleepIfNotClosed(sleepTimeSeconds: number) {
    if (this.closed) {
      return;
    }
    await delay(sleepTimeSeconds * 1000);
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closedFuture.resolve();
    this.startFuture.resolve(); // avoid deadlock of mainTaskImpl in case it never started
    this.textData.sentenceStream.close();
    await this.captureTask;
  }
}

export interface TranscriptionSynchronizerOptions {
  speed: number;
  hyphenateWord: (word: string) => string[];
  splitWords: (words: string) => [string, number, number][];
  sentenceTokenizer: SentenceTokenizer;
}

export const defaultTextSyncOptions: TranscriptionSynchronizerOptions = {
  speed: 1,
  hyphenateWord: basic.hyphenateWord,
  splitWords: basic.splitWords,
  sentenceTokenizer: new basic.SentenceTokenizer({
    retainFormat: true,
  }),
};

export class TranscriptionSynchronizer {
  readonly audioOutput: SyncedAudioOutput;
  readonly textOutput: SyncedTextOutput;

  private options: TextSyncOptions;
  private rotateSegmentTask: Task<void>;
  private _enabled: boolean = true;
  private closed: boolean = false;

  /** @internal */
  _impl: SegmentSynchronizerImpl;

  private logger = log();

  constructor(
    nextInChainAudio: AudioOutput,
    nextInChainText: TextOutput,
    options: TranscriptionSynchronizerOptions = defaultTextSyncOptions,
  ) {
    this.audioOutput = new SyncedAudioOutput(this, nextInChainAudio);
    this.textOutput = new SyncedTextOutput(this, nextInChainText);
    this.options = {
      speed: options.speed,
      hyphenateWord: options.hyphenateWord,
      splitWords: options.splitWords,
      sentenceTokenizer: options.sentenceTokenizer,
    };

    // initial segment/first segment, recreated for each new segment
    this._impl = new SegmentSynchronizerImpl(this.options, nextInChainText);
    this.rotateSegmentTask = Task.from((controller) =>
      this.rotateSegmentTaskImpl(controller.signal),
    );
  }

  get enabled(): boolean {
    return this._enabled;
  }

  set enabled(enabled: boolean) {
    if (this._enabled === enabled) {
      return;
    }

    this._enabled = enabled;
    this.rotateSegment();
  }

  rotateSegment() {
    if (this.closed) {
      return;
    }

    if (!this.rotateSegmentTask.done) {
      this.logger.warn('rotateSegment called while previous segment is still being rotated');
    }
    this.rotateSegmentTask = Task.from((controller) =>
      this.rotateSegmentTaskImpl(controller.signal, this.rotateSegmentTask),
    );
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.rotateSegmentTask.cancelAndWait();
    await this._impl.close();
  }

  async barrier(): Promise<void> {
    if (this.rotateSegmentTask.done) {
      return;
    }
    await this.rotateSegmentTask.result;
  }

  private async rotateSegmentTaskImpl(abort: AbortSignal, oldTask?: Task<void>) {
    if (oldTask) {
      await oldTask.result;
    }

    if (abort.aborted) {
      return;
    }

    await this._impl.close();
    this._impl = new SegmentSynchronizerImpl(this.options, this.textOutput.nextInChain);
  }
}

class SyncedAudioOutput extends AudioOutput {
  private pushedDuration: number = 0.0;

  constructor(
    public synchronizer: TranscriptionSynchronizer,
    private nextInChainAudio: AudioOutput,
  ) {
    super(nextInChainAudio.sampleRate, nextInChainAudio, { pause: true });
  }

  async captureFrame(frame: AudioFrame): Promise<void> {
    // using barrier() on capture should be sufficient, flush() must not be called if
    // capture_frame isn't completed
    await this.synchronizer.barrier();

    await super.captureFrame(frame);
    await this.nextInChainAudio.captureFrame(frame); // passthrough audio

    // TODO(AJS-102): use frame.durationMs once available in rtc-node
    this.pushedDuration += frame.samplesPerChannel / frame.sampleRate;

    if (!this.synchronizer.enabled) {
      return;
    }

    if (this.synchronizer._impl.audioInputEnded) {
      this.logger.warn(
        'SegmentSynchronizerImpl audio marked as ended in capture audio, rotating segment',
      );
      this.synchronizer.rotateSegment();
      await this.synchronizer.barrier();
    }
    this.synchronizer._impl.pushAudio(frame);
  }

  flush() {
    super.flush();
    this.nextInChainAudio.flush();

    if (!this.synchronizer.enabled) {
      return;
    }

    if (!this.pushedDuration) {
      // For timed texts, audio goes directly to room without going through synchronizer.
      // If text was pushed but no audio, still end audio input so text can be processed.
      // Only rotate if there's also no text (truly empty segment).
      if (this.synchronizer._impl.hasPendingText) {
        // Text is pending - end audio input to allow text processing
        this.synchronizer._impl.endAudioInput();
        return;
      }
      // No text and no audio - rotate the segment
      this.synchronizer.rotateSegment();
      return;
    }

    this.synchronizer._impl.endAudioInput();
  }

  clearBuffer() {
    this.nextInChainAudio.clearBuffer();
  }

  // this is going to be automatically called by the next_in_chain
  onPlaybackFinished(ev: PlaybackFinishedEvent) {
    if (!this.synchronizer.enabled) {
      super.onPlaybackFinished(ev);
      return;
    }

    this.synchronizer._impl.markPlaybackFinished(ev.playbackPosition, ev.interrupted);
    super.onPlaybackFinished({
      playbackPosition: ev.playbackPosition,
      interrupted: ev.interrupted,
      synchronizedTranscript: this.synchronizer._impl.synchronizedTranscript,
    });

    this.synchronizer.rotateSegment();
    this.pushedDuration = 0.0;
  }
}

class SyncedTextOutput extends TextOutput {
  private capturing: boolean = false;
  private logger = log();

  constructor(
    private readonly synchronizer: TranscriptionSynchronizer,
    public readonly nextInChain: TextOutput,
  ) {
    super(nextInChain);
  }

  async captureText(text: string | TimedString): Promise<void> {
    await this.synchronizer.barrier();

    const textStr = isTimedString(text) ? text.text : text;

    if (!this.synchronizer.enabled) {
      // pass through to the next in chain (extract string from TimedString if needed)
      await this.nextInChain.captureText(textStr);
      return;
    }

    this.capturing = true;
    if (this.synchronizer._impl.textInputEnded) {
      this.logger.warn(
        'SegmentSynchronizerImpl text marked as ended in capture text, rotating segment',
      );
      this.synchronizer.rotateSegment();
      await this.synchronizer.barrier();
    }
    // Pass the TimedString to pushText for timing extraction
    this.synchronizer._impl.pushText(text);
  }

  async flush() {
    // Wait for any pending rotation to complete before accessing _impl
    await this.synchronizer.barrier();

    if (!this.synchronizer.enabled) {
      this.nextInChain.flush(); // passthrough text if the synchronizer is disabled
      return;
    }

    if (!this.capturing) {
      return;
    }

    this.capturing = false;
    this.synchronizer._impl.endTextInput();
  }
}
