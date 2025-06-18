import type { AudioFrame } from '@livekit/rtc-node';
import { delay } from '@std/async';
import { IdentityTransform } from 'agents/src/stream/identity_transform.js';
import { log } from '../../log.js';
import type { SentenceStream, SentenceTokenizer } from '../../tokenize/index.js';
import { basic } from '../../tokenize/index.js';
import { Future, Task } from '../../utils.js';
import { AudioOutput, TextOutput } from '../io.js';

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
  private outputStream: IdentityTransform<string>;
  private outputStreamWriter: WritableStreamDefaultWriter<string>;
  private mainTask: Task<void>;

  private startFuture: Future = new Future();
  private closedFuture: Future = new Future();
  private playbackCompleted: boolean = false;
  private startWallTime: number | null = null;

  private logger = log();

  constructor(public options: TextSyncOptions) {
    this.options = options;
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

    this.mainTask = Task.from((controller) => this.mainTaskImpl(controller.signal));
    this.mainTask.result.then(() => this.outputStreamWriter.close());
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

  pushAudio(frame: AudioFrame) {
    if (this.closed) {
      this.logger.warn('SegmentSynchronizerImpl.pushAudio called after close');
      return;
    }
    // TODO(AJS-102): use frame.durationMs once available in rtc-node
    const framDuration = frame.samplesPerChannel / frame.sampleRate;
    if (!this.startWallTime && framDuration > 0) {
      this.startWallTime = Date.now();
      this.startFuture.resolve();
    }

    this.audioData.pushedDuration += framDuration;
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

    this.textData.sentenceStream.flush();
  }

  endTextInput() {
    if (this.closed) {
      this.logger.warn('SegmentSynchronizerImpl.endTextInput called after close');
      return;
    }
    this.textData.done = true;
    this.textData.sentenceStream.endInput();
  }

  markPlaybackFinished(_playbackPosition: number, _interrupted: boolean) {
    if (this.closed) {
      this.logger.warn('SegmentSynchronizerImpl.markPlaybackFinished called after close');
      return;
    }
    this.playbackCompleted = true;
  }

  get synchronizedTranscript(): string {
    if (this.playbackCompleted) {
      return this.textData.pushedText;
    }
    return this.textData.forwardedText;
  }

  private async mainTaskImpl(signal: AbortSignal): Promise<void> {
    await this.startFuture.await;

    if (this.closed && !this.playbackCompleted) {
      return;
    }

    if (!this.startWallTime) {
      throw new Error('startWallTime is not set when starting SegmentSynchronizerImpl.mainTask');
    }

    for await (const text_seg of this.textData.sentenceStream) {
      const sentence = text_seg.token;
      let text_cursor = 0;
      if ((this.closed && !this.playbackCompleted) || signal.aborted) {
        return;
      }
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for (const [word, _, end_pos] of this.options.splitWords(sentence)) {
        if (this.closed && !this.playbackCompleted) {
          return;
        }

        if (this.playbackCompleted) {
          this.outputStreamWriter.write(sentence.slice(text_cursor, end_pos));
          text_cursor = end_pos;
          continue;
        }

        const word_hyphens = this.options.hyphenateWord(word).length;
        let delay = word_hyphens / this.options.speed;

        if (this.playbackCompleted) {
          delay = 0;
        }

        await this.sleepIfNotClosed(delay / 2, signal);
        this.outputStreamWriter.write(sentence.slice(text_cursor, end_pos));
        await this.sleepIfNotClosed(delay / 2, signal);

        this.textData.forwardedHyphens += word_hyphens;
        text_cursor = end_pos;
      }

      if (text_cursor < sentence.length) {
        this.outputStreamWriter.write(sentence.slice(text_cursor));
      }
    }
  }

  private async sleepIfNotClosed(sleepTime: number, signal: AbortSignal) {
    if (this.closed) {
      return;
    }
    await delay(sleepTime, { signal });
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closedFuture.resolve();
    this.startFuture.resolve();
    await this.outputStreamWriter.close();
    this.textData.sentenceStream.close();
  }
}

export interface TranscriptionSynchronizerOptions {
  speed: number;
  hyphenateWord: (word: string) => string[];
  splitWords: (words: string) => [string, number, number][];
  sentenceTokenizer: SentenceTokenizer;
}

export const defaultTextSyncOptions: TranscriptionSynchronizerOptions = {
  speed: 1.0,
  hyphenateWord: basic.hyphenateWord,
  splitWords: basic.splitWords,
  sentenceTokenizer: new basic.SentenceTokenizer(),
};

export class TranscriptionSynchronizer {
  readonly audioOutput: SyncedAudioOutput;
  readonly textOutput: SyncedTextOutput;

  private options: TextSyncOptions;

  /* @internal */
  _impl: SegmentSynchronizerImpl;
  private rotateSegmentTask: Task<void>;
  private _enabled: boolean = true;
  private closed: boolean = false;

  private logger = log();

  constructor(options: TranscriptionSynchronizerOptions = defaultTextSyncOptions) {
    this.audioOutput = new SyncedAudioOutput(this);
    this.textOutput = new SyncedTextOutput(this);
    this.options = {
      speed: options.speed,
      hyphenateWord: options.hyphenateWord,
      splitWords: options.splitWords,
      sentenceTokenizer: options.sentenceTokenizer,
    };

    this._impl = new SegmentSynchronizerImpl(this.options);
    this.rotateSegmentTask = Task.from((controller) => this.rotate_segment_task(controller.signal));
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
      this.rotate_segment_task(controller.signal, this.rotateSegmentTask),
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

  private async rotate_segment_task(abort: AbortSignal, oldTask?: Task<void>) {
    if (oldTask) {
      if (abort.aborted) {
        return;
      }
      await oldTask.result;
    }

    if (abort.aborted) {
      return;
    }
    await this._impl.close();
    this._impl = new SegmentSynchronizerImpl(this.options);
  }
}

class SyncedAudioOutput extends AudioOutput {
  private _capturing: boolean = false;
  private pushedDuration: number = 0.0;
  private logger = log();

  constructor(public synchronizer: TranscriptionSynchronizer) {
    super();
  }

  async captureFrame(frame: AudioFrame): Promise<void> {
    await this.synchronizer.barrier();

    this._capturing = true;
    await super.captureFrame(frame);

    // TODO(AJS-102): use frame.durationMs once available in rtc-node
    this.pushedDuration += frame.samplesPerChannel / frame.sampleRate;

    if (!this.synchronizer.enabled) {
      return;
    }

    if (this.synchronizer._impl.audioInputEnded) {
      this.logger.warn(
        'SegmentSynchronizerImpl audio marked as ended in capture audio, rotating segment',
      );
      this.synchronizer._impl.markPlaybackFinished(this.pushedDuration, false);
    }
  }

  flush() {
    super.flush();
    if (!this.synchronizer.enabled) {
      return;
    }

    if (!this.pushedDuration) {
      // in case there is no audio after the text was pushed, rotate the segment
      this.synchronizer.rotateSegment();
      return;
    }

    this._capturing = false;
    this.synchronizer._impl.endAudioInput();
  }

  clearBuffer() {
    this._capturing = false;
  }
}

class SyncedTextOutput extends TextOutput {
  private _capturing: boolean = false;
  private logger = log();

  constructor(public synchronizer: TranscriptionSynchronizer) {
    super();
  }

  async captureText(text: string): Promise<void> {
    await this.synchronizer.barrier();

    this._capturing = true;
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
      return;
    }
    this._capturing = false;
    this.synchronizer._impl.endTextInput();
  }
}
