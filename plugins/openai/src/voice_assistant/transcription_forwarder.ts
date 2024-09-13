import type { AudioFrame, Room } from '@livekit/rtc-node';

export interface TranscriptionForwarder {
  start(): void;
  pushAudio(frame: AudioFrame): void;
  pushText(text: string): void;
  markTextFinished(): void;
  markAudioFinished(): void;
  close(): Promise<void>;
  publishedChars: number;
}

export class BasicTranscriptionForwarder implements TranscriptionForwarder {
  private room: Room;
  private participantIdentity: string;
  private trackSid: string;
  private currentText: string = '';
  private totalAudioDuration: number = 0;
  private currentAudioTimestamp: number = 0;
  private readonly DEFAULT_CHARS_PER_SECOND = 16;
  private charsPerSecond: number = this.DEFAULT_CHARS_PER_SECOND;
  private messageId: string;
  private isRunning: boolean = false;
  publishedChars: number = 0;

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
        console.error('Error in publishing loop:', error);
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

  private textFinished: boolean = false;
  private audioFinished: boolean = false;

  markTextFinished(): void {
    this.textFinished = true;
    this.adjustTimingIfBothFinished();
  }

  markAudioFinished(): void {
    this.audioFinished = true;
    this.adjustTimingIfBothFinished();
  }

  private adjustTimingIfBothFinished(): void {
    if (this.textFinished && this.audioFinished) {
      const actualDuration = this.totalAudioDuration;
      if (actualDuration > 0 && this.currentText.length > 0) {
        this.charsPerSecond = this.currentText.length / actualDuration;
      }
    }
  }

  private computeSleepInterval(): number {
    return Math.min(Math.max(1 / this.charsPerSecond, 0.0625), 0.5);
  }

  private async startPublishingLoop(): Promise<void> {
    this.isRunning = true;
    let sleepInterval = this.computeSleepInterval();
    while (this.isRunning) {
    //   console.warn('publishing transcription');
      this.currentAudioTimestamp += sleepInterval;
      await this.publishTranscription(false);
      sleepInterval = this.computeSleepInterval();
      if (this.isRunning) {
        await new Promise((resolve) => setTimeout(resolve, sleepInterval * 1000));
      }
    }
  }

  private async publishTranscription(final: boolean): Promise<void> {
    this.publishedChars = Math.floor(this.currentAudioTimestamp * this.charsPerSecond);
    const textToPublish = this.currentText.slice(0, this.publishedChars);
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

  async close(): Promise<void> {
    console.error('closing transcription forwarder');
    this.isRunning = false;

    // Ensure the last partial transcription was published.
    await new Promise((resolve) => setTimeout(resolve, this.computeSleepInterval() * 1000));

    // Publish whatever we had as final
    await this.publishTranscription(true);
  }
}
