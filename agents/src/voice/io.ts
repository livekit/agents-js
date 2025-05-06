import type { AudioFrame } from '@livekit/rtc-node';
import type { SpeechEvent } from '../stt/stt.js';

export type STTNode = (
  audio: ReadableStream<AudioFrame>,
  modelSettings: any, // TODO(shubhra): add type
) => Promise<AsyncIterable<SpeechEvent | string> | null>;
