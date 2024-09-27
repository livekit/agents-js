import type { AudioFrame, Room } from '@livekit/rtc-node';

export interface TranscriptionForwarder {
  start(): void;
  pushAudio(frame: AudioFrame): void;
  pushText(text: string): void;
  markTextComplete(): void;
  markAudioComplete(): void;
  close(interrupt: boolean): Promise<void>;
  currentCharacterIndex: number;
}
export declare class BasicTranscriptionForwarder implements TranscriptionForwarder {
  #private;
  currentCharacterIndex: number;
  constructor(room: Room, participantIdentity: string, trackSid: string, messageId: string);
  start(): void;
  pushAudio(frame: AudioFrame): void;
  pushText(text: string): void;
  private textIsComplete;
  private audioIsComplete;
  markTextComplete(): void;
  markAudioComplete(): void;
  private adjustTimingIfBothFinished;
  private computeSleepInterval;
  private startPublishingLoop;
  private publishTranscription;
  close(interrupt: boolean): Promise<void>;
}
//# sourceMappingURL=transcription.d.ts.map
