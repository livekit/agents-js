// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AudioFrame, Room } from '@livekit/rtc-node';
import { log } from './log.js';

/**
 * TranscriptionForwarder is an interface for creating incremental transcriptions of audio and text, such as chat logs.
 */
export interface TranscriptionForwarder {
  /** Start the forwarding */
  start(): void;
  /** Push an audio frame to the forwarder */
  pushAudio(frame: AudioFrame): void;
  /** Add a string of text to the forwarder */
  pushText(text: string): void;
  /** Mark text as complete */
  markTextComplete(): void;
  /** Mark audio as complete */
  markAudioComplete(): void;
  /** Close the forwarder */
  close(interrupt: boolean): Promise<void>;
  currentCharacterIndex: number;
}

export class BasicTranscriptionForwarder implements TranscriptionForwarder {
  #room: Room;
  #participantIdentity: string;
  #trackSid: string;
  #currentText: string = '';
  #totalAudioDuration: number = 0;
  #currentPlayoutTime: number = 0;
  #DEFAULT_CHARS_PER_SECOND = 16;
  #charsPerSecond: number = this.#DEFAULT_CHARS_PER_SECOND;
  #messageId: string;
  #isRunning: boolean = false;
  #logger = log();
  currentCharacterIndex: number = 0;

  constructor(room: Room, participantIdentity: string, trackSid: string, messageId: string) {
    this.#room = room;
    this.#participantIdentity = participantIdentity;
    this.#trackSid = trackSid;
    this.#messageId = messageId;
  }

  start(): void {
    if (!this.#isRunning) {
      this.#isRunning = true;
      this.#startPublishingLoop().catch((error) => {
        this.#logger.error('Error in publishing loop:', error);
        this.#isRunning = false;
      });
    }
  }

  pushAudio(frame: AudioFrame): void {
    this.#totalAudioDuration += frame.samplesPerChannel / frame.sampleRate;
  }

  pushText(text: string): void {
    this.#currentText += text;
  }

  #textIsComplete: boolean = false;
  #audioIsComplete: boolean = false;

  markTextComplete(): void {
    this.#textIsComplete = true;
    this.#adjustTimingIfBothFinished();
  }

  markAudioComplete(): void {
    this.#audioIsComplete = true;
    this.#adjustTimingIfBothFinished();
  }

  #adjustTimingIfBothFinished(): void {
    if (this.#textIsComplete && this.#audioIsComplete) {
      const actualDuration = this.#totalAudioDuration;
      if (actualDuration > 0 && this.#currentText.length > 0) {
        this.#charsPerSecond = this.#currentText.length / actualDuration;
      }
    }
  }

  #computeSleepInterval(): number {
    return Math.min(Math.max(1 / this.#charsPerSecond, 0.0625), 0.5);
  }

  async #startPublishingLoop(): Promise<void> {
    this.#isRunning = true;
    let sleepInterval = this.#computeSleepInterval();
    let isComplete = false;
    while (this.#isRunning && !isComplete) {
      this.#currentPlayoutTime += sleepInterval;
      this.currentCharacterIndex = Math.floor(this.#currentPlayoutTime * this.#charsPerSecond);
      isComplete = this.#textIsComplete && this.currentCharacterIndex >= this.#currentText.length;
      await this.#publishTranscription(false);
      if (this.#isRunning && !isComplete) {
        sleepInterval = this.#computeSleepInterval();
        await new Promise((resolve) => setTimeout(resolve, sleepInterval * 1000));
      }
    }

    if (this.#isRunning) {
      this.close(false);
    }
  }

  async #publishTranscription(final: boolean): Promise<void> {
    const textToPublish = this.#currentText.slice(0, this.currentCharacterIndex);
    await this.#room.localParticipant?.publishTranscription({
      participantIdentity: this.#participantIdentity,
      trackSid: this.#trackSid,
      segments: [
        {
          text: textToPublish,
          final: final,
          id: this.#messageId,
          startTime: BigInt(0),
          endTime: BigInt(0),
          language: '',
        },
      ],
    });
  }

  async close(interrupt: boolean): Promise<void> {
    this.#isRunning = false;

    // Publish whatever we had as final
    if (!interrupt) {
      this.currentCharacterIndex = this.#currentText.length;
    }
    await this.#publishTranscription(true);
  }
}
