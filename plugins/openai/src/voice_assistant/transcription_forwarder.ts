import type { AudioFrame, Room } from '@livekit/rtc-node';

export interface TranscriptionForwarder {
  pushAudio(frame: AudioFrame): void;
  pushText(text: string): void;
  close(): Promise<void>;
}

export class BasicTranscriptionForwarder implements TranscriptionForwarder {
  private room: Room;
  private participantIdentity: string;
  private trackSid: string;
  private currentText: string = '';
  private currentDuration: number = 0;
  private readonly CHARS_PER_SECOND = 8;
  private messageId: string;

  constructor(room: Room, participantIdentity: string, trackSid: string, messageId: string) {
    this.room = room;
    this.participantIdentity = participantIdentity;
    this.trackSid = trackSid;
    this.messageId = messageId;
  }

  pushAudio(frame: AudioFrame): void {
    this.currentDuration += frame.samplesPerChannel / 16000; // Assuming 16kHz sample rate
    this.publishTranscription();
  }

  pushText(text: string): void {
    this.currentText += text;
  }

  private publishTranscription(): void {
    const textToPublish = this.currentText.slice(
      0,
      Math.floor(this.currentDuration * this.CHARS_PER_SECOND),
    );
    this.room.localParticipant?.publishTranscription({
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
    // Publish final transcription
    this.currentDuration = this.currentText.length / this.CHARS_PER_SECOND;
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
