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
  private speed: number;
  private outputStream: IdentityTransform<string>;
  private outputStreamWriter: WritableStreamDefaultWriter<string>;
  private captureTask: Task<void>;

  private startFuture: Future = new Future();
  private closedFuture: Future = new Future();
  private playbackCompleted: boolean = false;
  private startWallTime: number | null = null;

  private logger = log();

  constructor(
    private readonly options: TextSyncOptions,
    private readonly nextInChain: TextOutput,
  ) {
    this.logger.debug('SegmentSynchronizerImpl constructor:', { options });
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

    this.logger.debug('SegmentSynchronizerImpl: starting mainTask');
    this.mainTask()
      .then(() => {
        this.logger.info('mainTask result');
        this.outputStreamWriter.close();
      })
      .catch((error) => {
        this.logger.error('mainTask error:', error);
      });
    this.captureTask = Task.from((controller) => this.captureTaskImpl(controller.signal));
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
    this.logger.debug(
      {
        frameDuration,
        samplesPerChannel: frame.samplesPerChannel,
        sampleRate: frame.sampleRate,
        currentPushedDuration: this.audioData.pushedDuration,
        startWallTime: this.startWallTime,
      },
      'pushAudio:',
    );

    if (!this.startWallTime && frameDuration > 0) {
      this.startWallTime = Date.now();
      this.logger.debug(
        { startWallTime: this.startWallTime },
        'pushAudio: setting startWallTime and resolving startFuture',
      );
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

    this.logger.debug(
      {
        text: text.substring(0, 100) + (text.length > 100 ? '...' : ''),
        textLength: text.length,
        currentPushedText:
          this.textData.pushedText.substring(0, 50) +
          (this.textData.pushedText.length > 50 ? '...' : ''),
        textDone: this.textData.done,
      },
      'pushText:',
    );

    this.textData.sentenceStream.pushText(text);
    this.textData.pushedText += text;

    this.textData.sentenceStream.flush();
    this.logger.debug('pushText: after pushText');
  }

  endTextInput() {
    if (this.closed) {
      this.logger.warn('SegmentSynchronizerImpl.endTextInput called after close');
      return;
    }
    this.logger.debug(
      {
        pushedText:
          this.textData.pushedText.substring(0, 100) +
          (this.textData.pushedText.length > 100 ? '...' : ''),
        pushedTextLength: this.textData.pushedText.length,
        wasAlreadyDone: this.textData.done,
      },
      'endTextInput:',
    );
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

  private async captureTaskImpl(signal: AbortSignal) {
    for await (const text of this.outputStream.readable) {
      if (signal.aborted) {
        this.logger.debug('captureTask: exiting early - aborted');
        break;
      }
      this.textData.forwardedText += text;
      await this.nextInChain.captureText(text);
    }
    this.nextInChain.flush();
  }

  private async mainTask(): Promise<void> {
    this.logger.debug(
      {
        closed: this.closed,
        playbackCompleted: this.playbackCompleted,
        startWallTime: this.startWallTime,
        textDone: this.textData.done,
        audioDone: this.audioData.done,
      },
      'mainTaskImpl: starting',
    );

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

    this.logger.debug(
      {
        startWallTime: this.startWallTime,
        pushedText: this.textData.pushedText,
        textDone: this.textData.done,
      },
      'mainTaskImpl: starting sentence stream iteration',
    );

    let sentenceCount = 0;
    try {
      for await (const text_seg of this.textData.sentenceStream) {
        sentenceCount++;
        const sentence = text_seg.token;
        this.logger.debug(
          {
            sentence: sentence.substring(0, 50) + (sentence.length > 50 ? '...' : ''),
            length: sentence.length,
          },
          `mainTaskImpl: processing sentence ${sentenceCount}:`,
        );

        let text_cursor = 0;
        if (this.closed && !this.playbackCompleted) {
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

          this.logger.debug(
            {
              word,
              wordHyphens: word_hyphens,
              elapsedSeconds: elapsed_in_seconds,
              targetHyphens,
              forwardedHyphens: this.textData.forwardedHyphens,
              hyphensBehind,
              calculatedDelay: delay,
              speed: this.options.speed,
            },
            'mainTaskImpl: word timing calculation',
          );

          if (this.playbackCompleted) {
            delay = 0;
          }

          await this.sleepIfNotClosed(delay / 2);
          this.outputStreamWriter.write(sentence.slice(text_cursor, end_pos));
          await this.sleepIfNotClosed(delay / 2);

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

  private async sleepIfNotClosed(sleepTime: number) {
    if (this.closed) {
      return;
    }
    await delay(sleepTime);
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closedFuture.resolve();
    this.startFuture.resolve(); // avoid deadlock of mainTaskImpl in case it never started
    this.textData.sentenceStream.close();
    await this.captureTask.cancelAndWait();
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
  sentenceTokenizer: new basic.SentenceTokenizer('en-US', 20, 10, true),
};

export class TranscriptionSynchronizer {
  readonly audioOutput: SyncedAudioOutput;
  readonly textOutput: SyncedTextOutput;

  private options: TextSyncOptions;
  private rotateSegmentTask: Task<void>;
  private _enabled: boolean = true;
  private closed: boolean = false;

  /* @internal */
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
    this._impl = new SegmentSynchronizerImpl(this.options, this.textOutput.nextInChain);
  }
}

class SyncedAudioOutput extends AudioOutput {
  private capturing: boolean = false;
  private pushedDuration: number = 0.0;
  private logger = log();

  constructor(
    public synchronizer: TranscriptionSynchronizer,
    public nextInChainAudio: AudioOutput,
  ) {
    super();
  }

  async captureFrame(frame: AudioFrame): Promise<void> {
    // using barrier() on capture should be sufficient, flush() must not be called if
    // capture_frame isn't completed
    await this.synchronizer.barrier();

    this.capturing = true;
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

    this.capturing = false;
    this.synchronizer._impl.endAudioInput();
  }

  clearBuffer() {
    this.nextInChainAudio.clearBuffer();
    this.capturing = false;
  }
}

class SyncedTextOutput extends TextOutput {
  private capturing: boolean = false;
  private logger = log();

  constructor(
    private readonly synchronizer: TranscriptionSynchronizer,
    public readonly nextInChain: TextOutput,
  ) {
    super();
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
