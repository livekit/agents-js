import type { AudioFrame, Room } from '@livekit/rtc-node';

export interface TranscriptionForwarder {
  pushAudio(frame: AudioFrame): void;
  pushText(text: string): void;
  markTextFinished(): void;
  markAudioFinished(): void;
  close(): Promise<void>;
}

export class BasicTranscriptionForwarder implements TranscriptionForwarder {
  private room: Room;
  private participantIdentity: string;
  private trackSid: string;
  private currentText: string = '';
  private currentDuration: number = 0;
  private readonly DEFAULT_CHARS_PER_SECOND = 2;
  private charsPerSecond: number = this.DEFAULT_CHARS_PER_SECOND;
  private messageId: string;
  private publishQueue: Promise<void> = Promise.resolve();
  private isPublishing: boolean = false;

  constructor(room: Room, participantIdentity: string, trackSid: string, messageId: string) {
    this.room = room;
    this.participantIdentity = participantIdentity;
    this.trackSid = trackSid;
    this.messageId = messageId;
  }

  pushAudio(frame: AudioFrame): void {
    this.currentDuration += frame.samplesPerChannel / frame.sampleRate;
    this.queuePublishTranscription();
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
      const actualDuration = this.currentDuration;
      if (actualDuration > 0 && this.currentText.length > 0) {
        this.charsPerSecond = this.currentText.length / actualDuration;
      }
      this.publishTranscription();
    }
  }

  private queuePublishTranscription(): void {
    if (!this.isPublishing) {
      this.isPublishing = true;
      this.publishQueue = this.publishQueue.then(async () => {
        await this.publishTranscription();
        this.isPublishing = false;
      });
    }
  }

  private async publishTranscription(): Promise<void> {
    const textToPublish = this.currentText.slice(
      0,
      Math.floor(this.currentDuration * this.charsPerSecond),
    );
    await this.room.localParticipant?.publishTranscription({
      participantIdentity: this.participantIdentity,
      trackSid: this.trackSid,
      segments: [
        {
          text: textToPublish,
          final: false,
          id: this.messageId,
          startTime: BigInt(0),
          endTime: BigInt(Math.floor(this.currentDuration * 1000000000)),
          language: '',
        },
      ],
    });
  }

  async close(): Promise<void> {
    // Wait for any ongoing publish operations to complete
    await this.publishQueue;

    // Publish final transcription
    this.publishTranscription();

    // Publish any remaining text as final
    if (this.currentText.length > 0) {
      this.room.localParticipant?.publishTranscription({
        participantIdentity: this.participantIdentity,
        trackSid: this.trackSid,
        segments: [
          {
            text: this.currentText,
            final: true,
            id: this.messageId,
            startTime: BigInt(0),
            endTime: BigInt(Math.floor(this.currentDuration * 1000000000)),
            language: '',
          },
        ],
      });
    }
  }
}
