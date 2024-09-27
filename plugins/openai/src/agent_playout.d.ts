/// <reference types="node" />
import type { AudioFrame } from '@livekit/rtc-node';
import { type AudioSource } from '@livekit/rtc-node';
import { EventEmitter } from 'events';
import type { TranscriptionForwarder } from '../../../agents/src/transcription.js';
import type { Queue } from '../../../agents/src/utils.js';

export declare class AgentPlayout {
  #private;
  constructor(audioSource: AudioSource);
  play(
    messageId: string,
    transcriptionFwd: TranscriptionForwarder,
    playoutQueue: Queue<AudioFrame | null>,
  ): PlayoutHandle;
  private playoutTask;
}
export declare class PlayoutHandle extends EventEmitter {
  messageId: string;
  transcriptionFwd: TranscriptionForwarder;
  playedAudioSamples: number;
  done: boolean;
  interrupted: boolean;
  playoutQueue: Queue<AudioFrame | null>;
  constructor(
    messageId: string,
    transcriptionFwd: TranscriptionForwarder,
    playoutQueue: Queue<AudioFrame | null>,
  );
  endInput(): void;
  interrupt(): void;
  publishedTextChars(): number;
  complete(): void;
}
//# sourceMappingURL=agent_playout.d.ts.map
