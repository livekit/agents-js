// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { log } from '../log.js';
import { SentenceStream } from '../tokenize/index.js';
import { Event } from '../utils.js';

export interface StreamPacerOptions {
  /** Minimum remaining audio duration in milliseconds before sending the next batch. */
  minRemainingAudio: number;
  /** Maximum text length sent to TTS at once. */
  maxTextLength: number;
}

export class SentenceStreamPacer {
  private readonly options: StreamPacerOptions;

  constructor(options: Partial<StreamPacerOptions> = {}) {
    this.options = {
      minRemainingAudio: options.minRemainingAudio ?? 5000,
      maxTextLength: options.maxTextLength ?? 300,
    };
  }

  /** @internal */
  wrap(sentStream: SentenceStream, pushedAudioDuration: () => number): SentenceStream {
    return new StreamPacerWrapper(this.options, sentStream, pushedAudioDuration);
  }
}

/** @internal */
export class StreamPacerWrapper extends SentenceStream {
  readonly _wakeupEvent = new Event();
  readonly _sentences: string[] = [];
  _wakeupTimer?: ReturnType<typeof setTimeout>;
  private readonly sentStream: SentenceStream;
  private readonly options: StreamPacerOptions;
  private readonly pushedAudioDuration: () => number;
  private closing = false;
  private inputEnded = false;

  constructor(
    options: StreamPacerOptions,
    sentStream: SentenceStream,
    pushedAudioDuration: () => number,
  ) {
    super();
    this.options = options;
    this.sentStream = sentStream;
    this.pushedAudioDuration = pushedAudioDuration;
    void this.recvTask();
    void this.sendTask().finally(() => this.queue.close());
  }

  pushText(text: string): void {
    this.sentStream.pushText(text);
  }

  flush(): void {
    this.sentStream.flush();
  }

  endInput(): void {
    this.sentStream.endInput();
    // recvTask sets inputEnded once the tokenizer has flushed its tail.
  }

  close(): void {
    this.sentStream.close();
    this.closing = true;
    if (this._wakeupTimer) {
      clearTimeout(this._wakeupTimer);
      this._wakeupTimer = undefined;
    }
    this._wakeupEvent.set();
  }

  private async recvTask(): Promise<void> {
    try {
      for await (const event of this.sentStream) {
        this._sentences.push(event.token);
        this._wakeupEvent.set();
      }
    } finally {
      this.inputEnded = true;
      this._wakeupEvent.set();
    }
  }

  private async sendTask(): Promise<void> {
    let audioStartTime = 0;
    let firstSentence = true;
    let prevAudioDuration = 0;
    let prevCheckTime = 0;
    let generationStarted = false;
    let generationStopped = false;

    while (!this.closing) {
      await this._wakeupEvent.wait();
      this._wakeupEvent.clear();
      if (this._wakeupTimer) {
        clearTimeout(this._wakeupTimer);
        this._wakeupTimer = undefined;
      }

      if (this.closing || (this.inputEnded && this._sentences.length === 0)) break;

      const audioDuration = this.pushedAudioDuration();
      const currentTime = performance.now();
      if (audioDuration > 0 && audioStartTime === 0) {
        audioStartTime = currentTime;
      }

      if (currentTime - prevCheckTime >= 100) {
        if (prevAudioDuration < audioDuration) {
          generationStarted = true;
        } else if (generationStarted) {
          generationStopped = true;
        }
        prevAudioDuration = audioDuration;
        prevCheckTime = currentTime;
      }

      const remainingAudio = audioStartTime > 0 ? audioStartTime + audioDuration - currentTime : 0;
      if (
        firstSentence ||
        (generationStopped && remainingAudio <= this.options.minRemainingAudio)
      ) {
        const batch: string[] = [];
        while (this._sentences.length) {
          batch.push(this._sentences.shift()!);
          if (
            firstSentence ||
            batch.reduce((length, sentence) => length + sentence.length, 0) >=
              this.options.maxTextLength
          ) {
            break;
          }
        }

        if (batch.length) {
          const text = batch.join(' ');
          this.queue.put({ token: text, segmentId: '' });
          log().debug({ text, remainingAudio }, 'sent text to tts');
          generationStarted = false;
          generationStopped = false;
          firstSentence = false;
        }
      }

      const waitTime = generationStarted
        ? 200
        : Math.max(500, remainingAudio - this.options.minRemainingAudio);
      this._wakeupTimer = setTimeout(() => this._wakeupEvent.set(), waitTime);
    }
  }
}
