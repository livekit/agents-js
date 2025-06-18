import type { AudioFrame } from '@livekit/rtc-node';
import { delay } from '@std/async';
import type { ReadableStream, WritableStreamDefaultWriter } from 'node:stream/web';
import { log } from '../../log.js';
import { IdentityTransform } from '../../stream/identity_transform.js';
import type { SentenceStream, SentenceTokenizer } from '../../tokenize/index.js';
import { basic } from '../../tokenize/index.js';
import { Future, Task } from '../../utils.js';
import { AudioOutput, TextOutput } from '../io.js';

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
  private outputStream: IdentityTransform<string>;
  private outputStreamWriter: WritableStreamDefaultWriter<string>;
  private mainTask: Task<void>;

  private startFuture: Future = new Future();
  private closedFuture: Future = new Future();
  private playbackCompleted: boolean = false;
  private startWallTime: number | null = null;

  private logger = log();

  constructor(public options: TextSyncOptions) {
    this.logger.debug('SegmentSynchronizerImpl constructor:', { options });
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

    this.logger.debug('SegmentSynchronizerImpl: starting mainTask');
    this.mainTask = Task.from((controller) => this.mainTaskImpl(controller.signal));
    this.mainTask.result
      .then(() => {
        this.logger.info('mainTask result');
        this.outputStreamWriter.close();
      })
      .catch((error) => {
        this.logger.error('mainTask error:', error);
      });
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
    this.logger.debug('pushAudio:', {
      frameDuration,
      samplesPerChannel: frame.samplesPerChannel,
      sampleRate: frame.sampleRate,
      currentPushedDuration: this.audioData.pushedDuration,
      startWallTime: this.startWallTime,
    });

    if (!this.startWallTime && frameDuration > 0) {
      this.startWallTime = Date.now();
      this.logger.debug('pushAudio: setting startWallTime and resolving startFuture', {
        startWallTime: this.startWallTime,
      });
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

    this.logger.debug('pushText:', {
      text: text.substring(0, 100) + (text.length > 100 ? '...' : ''),
      textLength: text.length,
      currentPushedText:
        this.textData.pushedText.substring(0, 50) +
        (this.textData.pushedText.length > 50 ? '...' : ''),
      textDone: this.textData.done,
    });

    this.textData.sentenceStream.pushText(text);
    this.textData.pushedText += text;

    this.textData.sentenceStream.flush();
    this.logger.debug('pushText: after flush');
  }

  endTextInput() {
    if (this.closed) {
      this.logger.warn('SegmentSynchronizerImpl.endTextInput called after close');
      return;
    }
    this.logger.debug('endTextInput:', {
      pushedText:
        this.textData.pushedText.substring(0, 100) +
        (this.textData.pushedText.length > 100 ? '...' : ''),
      pushedTextLength: this.textData.pushedText.length,
      wasAlreadyDone: this.textData.done,
    });
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
    this.logger.debug('mainTaskImpl: starting', {
      closed: this.closed,
      playbackCompleted: this.playbackCompleted,
      startWallTime: this.startWallTime,
      textDone: this.textData.done,
      audioDone: this.audioData.done,
      signalAborted: signal.aborted,
    });

    this.logger.debug('mainTaskImpl: waiting for startFuture');
    await this.startFuture.await;
    this.logger.debug('mainTaskImpl: startFuture resolved');

    if (this.closed && !this.playbackCompleted) {
      this.logger.debug(
        { closed: this.closed, playbackCompleted: this.playbackCompleted },
        'mainTaskImpl: exiting early - closed without playback completed',
      );
      return;
    }

    if (!this.startWallTime) {
      this.logger.error('mainTaskImpl: startWallTime is not set');
      throw new Error('startWallTime is not set when starting SegmentSynchronizerImpl.mainTask');
    }

    this.logger.debug('mainTaskImpl: starting sentence stream iteration', {
      startWallTime: this.startWallTime,
      pushedText: this.textData.pushedText,
      textDone: this.textData.done,
    });

    let sentenceCount = 0;
    try {
      for await (const text_seg of this.textData.sentenceStream) {
        sentenceCount++;
        const sentence = text_seg.token;
        this.logger.debug(`mainTaskImpl: processing sentence ${sentenceCount}:`, {
          sentence: sentence.substring(0, 50) + (sentence.length > 50 ? '...' : ''),
          length: sentence.length,
        });

        let text_cursor = 0;
        if ((this.closed && !this.playbackCompleted) || signal.aborted) {
          this.logger.debug('mainTaskImpl: exiting mid-sentence - closed or aborted');
          return;
        }

        const words = this.options.splitWords(sentence);
        this.logger.debug(`mainTaskImpl: sentence split into ${words.length} words`);

        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for (const [word, _, end_pos] of words) {
          if (this.closed && !this.playbackCompleted) {
            this.logger.debug('mainTaskImpl: exiting mid-word - closed without playback');
            return;
          }

          if (this.playbackCompleted) {
            this.logger.debug('mainTaskImpl: playback completed, flushing word:', word);
            this.outputStreamWriter.write(sentence.slice(text_cursor, end_pos));
            text_cursor = end_pos;
            continue;
          }

          const word_hyphens = this.options.hyphenateWord(word).length;
          const elapsed_in_seconds = (Date.now() - this.startWallTime) / 1000;
          const targetHyphens = elapsed_in_seconds * this.options.speed;
          const hyphensBehind = Math.max(0, targetHyphens - this.textData.forwardedHyphens);
          let delay = Math.max(0, word_hyphens - hyphensBehind) / this.options.speed;

          this.logger.debug('mainTaskImpl: word timing calculation', {
            word,
            wordHyphens: word_hyphens,
            elapsedSeconds: elapsed_in_seconds,
            targetHyphens,
            forwardedHyphens: this.textData.forwardedHyphens,
            hyphensBehind,
            calculatedDelay: delay,
            speed: this.options.speed,
          });

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
          const remaining = sentence.slice(text_cursor);
          this.logger.debug('mainTaskImpl: writing remaining text:', remaining);
          this.outputStreamWriter.write(remaining);
        }
      }
    } catch (error) {
      this.logger.error('mainTaskImpl: error in sentence stream processing', error);
      throw error;
    }

    this.logger.debug(`mainTaskImpl: completed processing ${sentenceCount} sentences`);
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
  speed: STANDARD_SPEECH_RATE,
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

    // initial segment/first segment, recreated for each new segment
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
