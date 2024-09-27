import { EventEmitter } from 'events';
import { Queue } from '../utils.js';
import { AudioFrame } from '@livekit/rtc-node';

/** @internal */
export interface RealtimeContent {
  responseId: string;
  itemId: string;
  outputIndex: number;
  contentIndex: number;
  text: string;
  audio: AudioFrame[];
  textStream: Queue<string | null>;
  audioStream: Queue<AudioFrame | null>;
  toolCalls: RealtimeToolCall[];
}

/** @internal */
export interface RealtimeOutput {
  responseId: string;
  itemId: string;
  outputIndex: number;
  role: string;
  type: 'message' | 'function_call';
  content: RealtimeContent[];
  donePromise: () => Promise<void>;
}

/** @internal */
export interface RealtimeResponse {
  id: string;
  status: string;
  output: RealtimeOutput[];
  donePromise: () => Promise<void>;
}

/** @internal */
export interface RealtimeToolCall {
  // Define properties for tool calls if needed
}

/** @internal */
export interface InputSpeechCommitted {
  itemId: string;
}

/** @internal */
export interface InputSpeechTranscriptionCompleted {
  itemId: string;
  transcript: string;
}

/** @internal */
export abstract class RealtimeSession extends EventEmitter {
  abstract queueMsg(msg: any): void;
  abstract defaultConversation: {
    item: {
      truncate(itemId: string, contentIndex: number, audioEnd: number): void;
    };
  };
}

/** @internal */
export abstract class RealtimeModel {
  abstract session(options: any): RealtimeSession;
  abstract close(): Promise<void>;
}
