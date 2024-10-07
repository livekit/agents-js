// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AudioFrame, ChatMessage, Room } from '@livekit/rtc-node';
import { log } from './log.js';
import { Mutex } from './utils.js';

export interface TranscriptionForwarder {
  start(): void;
  pushAudio(frame: AudioFrame): void;
  pushText(text: string): void;
  markTextComplete(): void;
  markAudioComplete(): void;
  close(interrupt: boolean): Promise<void>;
  currentCharacterIndex: number;
}

export enum TranscriptionType {
  TRANSCRIPTION = 'transcription',
  CHAT = 'chat',
  CHAT_AND_TRANSCRIPTION = 'chat_and_transcription',
}

export class BasicTranscriptionForwarder implements TranscriptionForwarder {
  #DEFAULT_CHARS_PER_SECOND = 16;

  protected room: Room;
  protected participantIdentity: string;
  protected trackSid: string;
  protected currentText: string = '';
  protected totalAudioDuration: number = 0;
  protected currentPlayoutTime: number = 0;
  protected messageId: string;
  protected isRunning: boolean = false;
  protected logger = log();
  protected charsPerSecond: number = this.#DEFAULT_CHARS_PER_SECOND;
  protected textIsComplete: boolean = false;
  protected audioIsComplete: boolean = false;

  currentCharacterIndex: number = 0;

  constructor(room: Room, participantIdentity: string, trackSid: string, messageId: string) {
    this.room = room;
    this.participantIdentity = participantIdentity;
    this.trackSid = trackSid;
    this.messageId = messageId;
  }

  start(): void {
    if (!this.isRunning) {
      this.isRunning = true;
      this.startPublishingLoop().catch((error) => {
        this.logger.error('Error in publishing loop:', error);
        this.isRunning = false;
      });
    }
  }

  pushAudio(frame: AudioFrame): void {
    this.totalAudioDuration += frame.samplesPerChannel / frame.sampleRate;
  }

  pushText(text: string): void {
    this.currentText += text;
  }

  markTextComplete(): void {
    this.textIsComplete = true;
    this.#adjustTimingIfBothFinished();
  }

  markAudioComplete(): void {
    this.audioIsComplete = true;
    this.#adjustTimingIfBothFinished();
  }

  #adjustTimingIfBothFinished(): void {
    if (this.textIsComplete && this.audioIsComplete) {
      const actualDuration = this.totalAudioDuration;
      if (actualDuration > 0 && this.currentText.length > 0) {
        this.charsPerSecond = this.currentText.length / actualDuration;
      }
    }
  }

  protected computeSleepInterval(): number {
    return Math.min(Math.max(1 / this.charsPerSecond, 0.0625), 0.5);
  }

  protected async startPublishingLoop(): Promise<void> {
    this.isRunning = true;
    let sleepInterval = this.computeSleepInterval();
    let isComplete = false;
    while (this.isRunning && !isComplete) {
      this.currentPlayoutTime += sleepInterval;
      this.currentCharacterIndex = Math.floor(this.currentPlayoutTime * this.charsPerSecond);
      isComplete = this.textIsComplete && this.currentCharacterIndex >= this.currentText.length;
      await this.publishTranscription(false);
      if (this.isRunning && !isComplete) {
        sleepInterval = this.computeSleepInterval();
        await new Promise((resolve) => setTimeout(resolve, sleepInterval * 1000));
      }
    }

    if (this.isRunning) {
      this.close(false);
    }
  }

  protected async publishTranscription(final: boolean): Promise<void> {
    const textToPublish = this.currentText.slice(0, this.currentCharacterIndex);
    await this.room.localParticipant?.publishTranscription({
      participantIdentity: this.participantIdentity,
      trackSid: this.trackSid,
      segments: [
        {
          text: textToPublish,
          final: final,
          id: this.messageId,
          startTime: BigInt(0),
          endTime: BigInt(0),
          language: '',
        },
      ],
    });
  }

  async close(interrupt: boolean): Promise<void> {
    this.isRunning = false;

    // Publish whatever we had as final
    if (!interrupt) {
      this.currentCharacterIndex = this.currentText.length;
    }
    await this.publishTranscription(true);
  }
}

export class ChatAndTranscriptionForwarder extends BasicTranscriptionForwarder {
  protected type: TranscriptionType;
  protected originalMessage?: ChatMessage;
  protected chatMutex: Mutex;

  constructor(
    room: Room,
    participantIdentity: string,
    trackSid: string,
    messageId: string,
    transcriptionType: TranscriptionType,
  ) {
    super(room, participantIdentity, trackSid, messageId);
    this.type = transcriptionType;
    this.chatMutex = new Mutex();
  }

  override async startPublishingLoop() {
    this.isRunning = true;
    let sleepInterval = this.computeSleepInterval();
    let isComplete = false;
    while (this.isRunning && !isComplete) {
      this.currentPlayoutTime += sleepInterval;
      this.currentCharacterIndex = Math.floor(this.currentPlayoutTime * this.charsPerSecond);
      isComplete = this.textIsComplete && this.currentCharacterIndex >= this.currentText.length;
      switch (this.type) {
        case TranscriptionType.CHAT:
        case TranscriptionType.CHAT_AND_TRANSCRIPTION:
          await this.sendChatMessage();
        case TranscriptionType.TRANSCRIPTION:
        case TranscriptionType.CHAT_AND_TRANSCRIPTION:
          await this.publishTranscription(false);
        default:
          break;
      }
      if (this.isRunning && !isComplete) {
        sleepInterval = this.computeSleepInterval();
        await new Promise((resolve) => setTimeout(resolve, sleepInterval * 1000));
      }
    }

    if (this.isRunning) {
      this.close(false);
    }
  }

  protected async sendChatMessage() {
    const unlock = await this.chatMutex.lock();
    try {
      if (this.originalMessage) {
        this.room.localParticipant?.editChatMessage(this.currentText, this.originalMessage);
      } else {
        this.originalMessage = await this.room.localParticipant?.sendChatMessage(this.currentText);
      }
    } finally {
      unlock();
    }
  }
}
