// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
export type UnixTimestamp = number;
export type AudioBase64Bytes = string;
export type Modalities = ['text', 'audio'] | ['text'];
export type Voice = 'alloy' | 'shimmer' | 'echo';

export interface RealtimeSession {
  id: string;
  object: 'realtime.session';
  created_at: UnixTimestamp;
  model: string;
  modalities: Modalities;
  voice: Voice;
  input_audio_format: 'pcm16' | 'g711_ulaw' | 'g711_alaw';
  output_audio_format: 'pcm16' | 'g711_ulaw' | 'g711_alaw';
  input_audio_transcription: null | {
    model: 'whisper-1';
  };
  turn_detection:
    | {
        type: 'server_vad';
        threshold: number; // 0.0 to 1.0
        prefix_padding_ms: number;
        silence_duration_ms: number;
      }
    | 'none';
  tools: Tool[];
  tool_choice: 'auto' | 'none' | 'required';
  temperature: number; // 0.8 default
  max_output_tokens: number | null;
}

export interface Tool {
  type: 'function';
  name: string;
  description: string | null;
  parameters: JsonSchema;
}

export interface JsonSchema {
  type: 'object';
  properties: {
    [prop: string]: {
      [prop: string]: any;
    };
  };
  required_properties: string[];
}

export interface RealtimeConversation {
  id: string;
  object: 'realtime.conversation';
  created_at: UnixTimestamp;
  items: RealtimeItem[];
}

export type RealtimeItem = MessageItem | FunctionCallItem | FunctionCallOutputItem;

export interface MessageItem {
  id: string;
  object: 'realtime.item';
  created_at: UnixTimestamp;
  type: 'message';
  role: 'system' | 'user' | 'assistant';
  content: (InputText | InputAudio | TextContent | AudioContent)[];
}

export interface FunctionCallItem {
  id: string;
  object: 'realtime.item';
  type: 'function_call';
  call_id: string;
  name: string;
  arguments: string;
}

export interface FunctionCallOutputItem {
  id: string;
  object: 'realtime.item';
  type: 'function_call_output';
  call_id: string;
  output: string;
}

export interface InputText {
  type: 'input_text';
  text: string;
}

export interface InputAudio {
  type: 'input_audio';
  audio: AudioBase64Bytes;
  transcript: string | null;
}

export interface TextContent {
  type: 'text';
  text: string;
}

export interface AudioContent {
  type: 'audio';
  audio: AudioBase64Bytes;
  transcript: string;
}

export interface RealtimeResponse {
  id: string;
  object: 'realtime.response';
  created_at: UnixTimestamp;
  status: 'in_progress' | 'completed' | 'incomplete' | 'cancelled' | 'failed';
  status_details: null | StatusDetails;
  output: RealtimeItem[];
  usage: TokenUsage | null;
}

export interface StatusDetails {
  type: 'incomplete' | 'failed';
  reason: 'interruption' | 'max_output_tokens' | 'content_filter' | string;
  error?: {
    code: string;
    message: string;
  };
}

export interface TokenUsage {
  total_tokens: number;
  input_tokens: number;
  output_tokens: number;
}

export type ClientEvent =
  | SessionUpdateEvent
  | InputAudioBufferAppendEvent
  | ResponseCreateEvent
  | ResponseCancelEvent
  | ConversationItemCreatedEvent;

export interface SessionUpdateEvent {
  event_id?: string;
  type: 'session.update';
  session: Partial<RealtimeSession>;
}

export interface InputAudioBufferAppendEvent {
  event_id?: string;
  type: 'input_audio_buffer.append';
  audio: AudioBase64Bytes;
}

export interface ResponseCreateEvent {
  event_id?: string;
  type: 'response.create';
  response: Partial<RealtimeResponse>;
}

export interface ResponseCancelEvent {
  event_id?: string;
  type: 'response.cancel';
}

export interface ConversationItemCreatedEvent {
  event_id?: string;
  type: 'conversation.item.created';
  item: RealtimeItem;
}

export type ServerEvent =
  | SessionCreatedEvent
  | ConversationCreatedEvent
  | ResponseCreatedEvent
  | ResponseDoneEvent;

export interface SessionCreatedEvent {
  event_id: string;
  type: 'session.created';
  session: RealtimeSession;
}

export interface ConversationCreatedEvent {
  event_id: string;
  type: 'conversation.created';
  conversation: RealtimeConversation;
}

export interface ResponseCreatedEvent {
  event_id: string;
  type: 'response.created';
  response: RealtimeResponse;
}

export interface ResponseDoneEvent {
  event_id: string;
  type: 'response.done';
  response: RealtimeResponse;
}

export const API_URL = 'wss://api.openai.com/v1/realtime';
export const SAMPLE_RATE = 24000;
export const NUM_CHANNELS = 1;
export const INPUT_PCM_FRAME_SIZE = 2400; // 100ms
export const OUTPUT_PCM_FRAME_SIZE = 1200; // 50ms

export enum State {
  INITIALIZING = 'initializing',
  LISTENING = 'listening',
  THINKING = 'thinking',
  SPEAKING = 'speaking',
}
