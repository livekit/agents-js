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
import { AudioOutput, type PlaybackFinishedEvent, TextOutput } from '../io.js';

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

interface AudioData {
  pushedDuration: number;
  done: boolean;
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

  pushText(text: string) {
    if (this.closed) {
      this.logger.warn('SegmentSynchronizerImpl.pushText called after close');
      return;
    }

    this.textData.sentenceStream.pushText(text);
    this.textData.pushedText += text;
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
    const reader = this.outputStream.readable.getReader();
    while (true) {
      const { done, value: text } = await reader.read();
      if (done) {
        break;
      }
      this.textData.forwardedText += text;
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
        const targetHyphens = elapsedSeconds * this.options.speed;
        const hyphensBehind = Math.max(0, targetHyphens - this.textData.forwardedHyphens);
        let delay = Math.max(0, wordHphens - hyphensBehind) / this.speed;

        if (this.playbackCompleted) {
          delay = 0;
        }

        await this.sleepIfNotClosed(delay / 2);
        this.outputStreamWriter.write(sentence.slice(textCursor, endPos));
        await this.sleepIfNotClosed(delay / 2);

        this.textData.forwardedHyphens += wordHphens;
        textCursor = endPos;
      }

      if (textCursor < sentence.length) {
        const remaining = sentence.slice(textCursor);
        this.outputStreamWriter.write(remaining);
      }
    }
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
    super(nextInChainAudio.sampleRate, nextInChainAudio);
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
      // in case there is no audio after the text was pushed, rotate the segment
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

  async captureText(text: string): Promise<void> {
    await this.synchronizer.barrier();

    if (!this.synchronizer.enabled) {
      // pass through to the next in chain
      await this.nextInChain.captureText(text);
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
    this.synchronizer._impl.pushText(text);
  }

  flush() {
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
