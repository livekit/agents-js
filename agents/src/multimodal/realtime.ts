import { EventEmitter } from 'events';
import { Queue } from '../utils.js';
import { AudioFrame } from '@livekit/rtc-node';

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

export interface RealtimeOutput {
  responseId: string;
  itemId: string;
  outputIndex: number;
  role: string;
  type: 'message' | 'function_call';
  content: RealtimeContent[];
  donePromise: () => Promise<void>;
}

export interface RealtimeResponse {
  id: string;
  status: string;
  output: RealtimeOutput[];
  donePromise: () => Promise<void>;
}

export interface RealtimeToolCall {
  // Define properties for tool calls if needed
}

export interface InputSpeechCommitted {
  itemId: string;
}

export interface InputSpeechTranscriptionCompleted {
  itemId: string;
  transcript: string;
}

export abstract class RealtimeSession extends EventEmitter {
  abstract queueMsg(msg: any): void;
  abstract defaultConversation: {
    item: {
      truncate(itemId: string, contentIndex: number, audioEnd: number): void;
    };
  };
}

export abstract class RealtimeModel {
  abstract session(options: any): RealtimeSession;
  abstract close(): Promise<void>;
}
