// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { TranscriptionSegment } from '@livekit/protocol';
import { AudioFrame } from '@livekit/rtc-node';
import type { TypedEventEmitter as TypedEmitter } from '@livekit/typed-emitter';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { basic } from './tokenize/index.js';
import type { SentenceStream, SentenceTokenizer } from './tokenize/tokenizer.js';
import { AsyncIterableQueue, Future } from './utils.js';

// standard speech rate in hyphens/ms
const STANDARD_SPEECH_RATE = 3830;

export interface TextSyncOptions {
  language: string;
  speed: number;
  newSentenceDelay: number;
  sentenceTokenizer: SentenceTokenizer;
  hyphenateWord: (word: string) => string[];
  splitWords: (words: string) => [string, number, number][];
}

export const defaultTextSyncOptions: TextSyncOptions = {
  language: '',
  speed: 1,
  newSentenceDelay: 400,
  sentenceTokenizer: new basic.SentenceTokenizer(),
  hyphenateWord: basic.hyphenateWord,
  splitWords: basic.splitWords,
};

interface AudioData {
  pushedDuration: number;
  done: boolean;
}

interface TextData {
  sentenceStream: SentenceStream;
  pushedText: string;
  done: boolean;
  forwardedHyphens: number;
  forwardedSentences: number;
}

type SyncCallbacks = {
  textUpdated: (text: TranscriptionSegment) => void;
};

export class TextAudioSynchronizer extends (EventEmitter as new () => TypedEmitter<SyncCallbacks>) {
  #opts: TextSyncOptions;
  #speed: number;

  #closed = false;
  #interrupted = false;
  #closeFut = new Future();

  #playingSegIndex = -1;
  #finishedSegIndex = -1;

  #textQChanged = new AsyncIterableQueue<number>();
  #textQ: (TextData | undefined)[] = [];
  #audioQChanged = new AsyncIterableQueue<number>();
  #audioQ: (AudioData | undefined)[] = [];

  #playedText = '';
  #task?: Promise<void>;

  #audioData?: AudioData;
  #textData?: TextData;

  constructor(opts: TextSyncOptions) {
    super();

    this.#opts = opts;
    this.#speed = opts.speed * STANDARD_SPEECH_RATE;
  }

  pushAudio(frame: AudioFrame) {
    this.#checkNotClosed();
    if (!this.#audioData) {
      this.#audioData = { pushedDuration: 0, done: false };
      this.#audioQ.push(this.#audioData);
      this.#audioQChanged.put(1);
    }
    this.#audioData.pushedDuration += frame.samplesPerChannel / frame.sampleRate;
  }

  pushText(text: string) {
    this.#checkNotClosed();
    if (!this.#textData) {
      this.#textData = {
        sentenceStream: this.#opts.sentenceTokenizer.stream(),
        pushedText: '',
        done: false,
        forwardedHyphens: 0,
        forwardedSentences: 0,
      };
      this.#textQ.push(this.#textData);
      this.#textQChanged.put(1);
    }

    this.#textData.pushedText += text;
    this.#textData.sentenceStream.pushText(text);
  }

  markAudioSegmentEnd() {
    this.#checkNotClosed();

    if (!this.#audioData) {
      // create empty audio data if none exists
      this.pushAudio(new AudioFrame(new Int16Array(), 24000, 1, 0));
    }

    this.#audioData!.done = true;
    this.#audioData = undefined;
  }

  markTextSegmentEnd() {
    this.#checkNotClosed();

    if (!this.#textData) {
      this.pushText('');
    }

    this.#textData!.done = true;
    this.#textData?.sentenceStream.flush();
    this.#textData?.sentenceStream.close();
    this.#textData = undefined;
  }

  segmentPlayoutStarted() {
    this.#checkNotClosed();
    this.#playingSegIndex++;

    if (!this.#task) {
      this.#task = this.#mainLoop();
    }
  }

  segmentPlayoutFinished() {
    this.#checkNotClosed();
    this.#finishedSegIndex++;
  }

  get playedText(): string {
    return this.#playedText;
  }

  async close(interrupt: boolean) {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#interrupted = interrupt;
    this.#closeFut.resolve();

    for (const textData of this.#textQ) {
      textData?.sentenceStream.close();
    }

    this.#textQ.push(undefined);
    this.#audioQ.push(undefined);
    this.#textQChanged.put(1);
    this.#audioQChanged.put(1);

    await this.#task;
  }

  async #mainLoop() {
    let segIndex = 0;
    let qDone = false;

    while (!qDone) {
      await this.#textQChanged.next();
      await this.#audioQChanged.next();

      while (this.#textQ.length && this.#audioQ.length) {
        const textData = this.#textQ.pop();
        const audioData = this.#audioQ.pop();

        if (!(textData && audioData)) {
          qDone = true;
          break;
        }

        // wait for segment to start playing
        while (!this.#closed) {
          if (this.#playingSegIndex >= segIndex) break;
          await this.#sleepIfNotClosed(125);
        }

        const sentenceStream = textData.sentenceStream;
        const forwardStartTime = Date.now();

        for await (const ev of sentenceStream) {
          await this.#syncSentence(segIndex, forwardStartTime, textData, audioData, ev.token);
        }

        segIndex++;
      }
    }
  }

  async #syncSentence(
    segIndex: number,
    segStartTime: number,
    textData: TextData,
    audioData: AudioData,
    sentence: string,
  ) {
    let realSpeed: number | undefined;
    if (audioData.pushedDuration > 0 && audioData.done) {
      realSpeed = this.#calcHyphens(textData.pushedText).length / audioData.pushedDuration;
    }

    const segId = 'SG_' + randomUUID();
    const words = this.#opts.splitWords(sentence);
    const processedWords: string[] = [];

    const ogText = this.#playedText;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for (const [word, _, end] of words) {
      if (segIndex <= this.#finishedSegIndex) break;
      if (this.#interrupted) return;

      const wordHyphens = this.#opts.hyphenateWord(word).length;
      processedWords.push(word);

      const elapsed = Date.now() - segStartTime;
      const text = sentence.slice(0, end); // TODO: rstrip punctuations

      let speed = this.#speed;
      let delay: number;
      if (realSpeed) {
        speed = realSpeed;
        const estimatedPausesMs = textData.forwardedSentences * this.#opts.newSentenceDelay;
        const hyphPauses = estimatedPausesMs * speed;
        const targetHyphens = Math.round(speed * elapsed);
        const dt = targetHyphens - textData.forwardedHyphens - hyphPauses;
        const toWaitHyphens = Math.max(0, wordHyphens - dt);
        delay = toWaitHyphens / speed;
      } else {
        delay = wordHyphens / speed;
      }

      const firstDelay = Math.min(delay / 2, 2 / speed);
      await this.#sleepIfNotClosed(firstDelay * 1000000);

      this.emit(
        'textUpdated',
        new TranscriptionSegment({
          id: segId,
          text: text,
          startTime: BigInt(0),
          endTime: BigInt(0),
          final: false,
          language: this.#opts.language,
        }),
      );

      this.#playedText = `${ogText} ${text}`;
      await this.#sleepIfNotClosed((delay - firstDelay) * 1000000);
      textData.forwardedHyphens += wordHyphens;
    }

    this.emit(
      'textUpdated',
      new TranscriptionSegment({
        id: segId,
        text: sentence,
        startTime: BigInt(0),
        endTime: BigInt(0),
        final: true,
        language: this.#opts.language,
      }),
    );

    this.#playedText = `${ogText} ${sentence}`;

    await this.#sleepIfNotClosed(this.#opts.newSentenceDelay);
    textData.forwardedSentences++;
  }

  async #sleepIfNotClosed(delay: number) {
    await Promise.race([
      this.#closeFut.await,
      new Promise((resolve) => setTimeout(resolve, delay)),
    ]);
  }

  #calcHyphens(text: string): string[] {
    const hyphens: string[] = [];
    const words = this.#opts.splitWords(text);
    for (const word of words) {
      const n = this.#opts.hyphenateWord(word[0]);
      hyphens.push(...n);
    }
    return hyphens;
  }

  #checkNotClosed() {
    if (this.#closed) {
      throw new Error('TextAudioSynchronizer is closed');
    }
  }
}
