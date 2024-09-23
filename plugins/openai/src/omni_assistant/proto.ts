// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
// Basic Types
export type AudioBase64Bytes = string; // Base64 encoded audio data
export type JsonSchema = {
  type: 'object';
  properties: {
    [prop: string]: {
      [prop: string]: any;
    };
  };
  required_properties: string[];
};

// Content Part Types
export interface InputTextContent {
  type: 'input_text';
  text: string;
}

export interface InputAudioContent {
  type: 'input_audio';
  // 'audio' field is excluded when rendered
  // audio: AudioBase64Bytes;
  transcript: string | null;
}

export interface TextContent {
  type: 'text';
  text: string;
}

export interface AudioContent {
  type: 'audio';
  // 'audio' field is excluded when rendered
  // audio: AudioBase64Bytes;
  transcript: string;
}

export type ContentPart = InputTextContent | InputAudioContent | TextContent | AudioContent;

// Item Resource Types
export interface BaseItem {
  id: string;
  object: 'realtime.item';
  previous_item_id: string | null;
  type: string;
}

export interface SystemMessageItem extends BaseItem {
  type: 'message';
  role: 'system';
  content: [InputTextContent];
}

export interface UserMessageItem extends BaseItem {
  type: 'message';
  role: 'user';
  content: [InputTextContent | InputAudioContent];
}

export interface AssistantMessageItem extends BaseItem {
  type: 'message';
  role: 'assistant';
  content: [TextContent | AudioContent];
}

export interface FunctionCallItem extends BaseItem {
  type: 'function_call';
  call_id: string;
  name: string;
  arguments: string;
}

export interface FunctionCallOutputItem extends BaseItem {
  type: 'function_call_output';
  call_id: string;
  output: string;
}

export type ItemResource =
  | SystemMessageItem
  | UserMessageItem
  | AssistantMessageItem
  | FunctionCallItem
  | FunctionCallOutputItem;

// Session Resource
export interface SessionResource {
  id: string;
  object: 'realtime.session';
  model: string;
  modalities: ['text', 'audio'] | ['text']; // default: ["text", "audio"]
  instructions: string | null; // default: null
  voice: 'alloy' | 'shimmer' | 'echo'; // default: "alloy"
  input_audio_format: 'pcm16' | 'g711_ulaw' | 'g711_alaw'; // default: "pcm16"
  output_audio_format: 'pcm16' | 'g711_ulaw' | 'g711_alaw'; // default: "pcm16"
  input_audio_transcription: null | {
    model: 'whisper-1';
  }; // default: null
  turn_detection:
    | {
        type: 'server_vad';
        threshold: number; // 0.0 to 1.0, default: 0.5
        prefix_padding_ms: number; // default: 300
        silence_duration_ms: number; // default: 200
      }
    | 'none';
  tools: Array<Tool>;
  tool_choice: 'auto' | 'none' | 'required'; // default: "auto"
  temperature: number; // default: 0.8
  max_output_tokens: number | null; // default: null (infinite)
}

// Conversation Resource
export interface ConversationResource {
  id: string;
  object: 'realtime.conversation';
}

// Response Resource
export type ResponseStatus = 'in_progress' | 'completed' | 'incomplete' | 'cancelled' | 'failed';

export type ResponseStatusDetails =
  | null
  | {
      type: 'incomplete';
      reason: 'interruption' | 'max_output_tokens' | 'content_filter';
    }
  | {
      type: 'failed';
      error: null | {
        code: 'server_error' | 'rate_limit_exceeded' | string;
        message: string;
      };
    };

export interface ResponseResource {
  id: string;
  object: 'realtime.response';
  status: ResponseStatus;
  status_details: ResponseStatusDetails;
  output: ItemResource[];
  usage: null | {
    total_tokens: number;
    input_tokens: number;
    output_tokens: number;
  };
}

// Client Events
export interface SessionUpdateEvent {
  event_id?: string;
  type: 'session.update';
  session: Partial<{
    modalities: ['text', 'audio'] | ['text'];
    instructions: string | null;
    voice: 'alloy' | 'shimmer' | 'echo' | null;
    input_audio_format: 'pcm16' | 'g711_ulaw' | 'g711_alaw' | null;
    output_audio_format: 'pcm16' | 'g711_ulaw' | 'g711_alaw' | null;
    input_audio_transcription: null | {
      model: 'whisper-1';
    };
    turn_detection:
      | null
      | {
          type: 'server_vad';
          threshold?: number | null;
          prefix_padding_ms?: number | null;
          silence_duration_ms?: number | null;
        }
      | 'none';
    tools: Array<{
      type: 'function';
      name: string;
      description: string | null;
      parameters: JsonSchema;
    }> | null;
    tool_choice: 'auto' | 'none' | 'required' | null;
    temperature: number | null;
    max_output_tokens: number | null;
  }>;
}

export interface InputAudioBufferAppendEvent {
  event_id?: string;
  type: 'input_audio_buffer.append';
  audio: AudioBase64Bytes;
}

export interface InputAudioBufferCommitEvent {
  event_id?: string;
  type: 'input_audio_buffer.commit';
}

export interface InputAudioBufferClearEvent {
  event_id?: string;
  type: 'input_audio_buffer.clear';
}

export interface ConversationItemCreateEvent {
  event_id?: string;
  type: 'conversation.item.create';
  item:
    | {
        type: 'message';
        role: 'user';
        content: [InputTextContent | InputAudioContent];
      }
    | {
        type: 'message';
        role: 'assistant';
        content: [TextContent];
      }
    | {
        type: 'message';
        role: 'system';
        content: [InputTextContent];
      }
    | {
        type: 'function_call_output';
        call_id: string;
        output: string;
      };
}

export interface ConversationItemTruncateEvent {
  event_id?: string;
  type: 'conversation.item.truncate';
  item_id: string;
  content_index: number;
  audio_end_ms: number;
}

export interface ConversationItemDeleteEvent {
  event_id?: string;
  type: 'conversation.item.delete';
  item_id: string;
}

export interface ResponseCreateEvent {
  event_id?: string;
  type: 'response.create';
  response: Partial<{
    modalities: ['text', 'audio'] | ['text'] | null;
    instructions: string | null;
    voice: 'alloy' | 'shimmer' | 'echo' | null;
    output_audio_format: 'pcm16' | 'g711_ulaw' | 'g711_alaw' | null;
    tools: Array<{
      type: 'function';
      name: string;
      description: string | null;
      parameters: JsonSchema;
    }> | null;
    tool_choice: 'auto' | 'none' | 'required' | null;
    temperature: number | null;
    max_output_tokens: number | null;
  }>;
}

export interface ResponseCancelEvent {
  event_id?: string;
  type: 'response.cancel';
}

export type ClientEvent =
  | SessionUpdateEvent
  | InputAudioBufferAppendEvent
  | InputAudioBufferCommitEvent
  | InputAudioBufferClearEvent
  | ConversationItemCreateEvent
  | ConversationItemTruncateEvent
  | ConversationItemDeleteEvent
  | ResponseCreateEvent
  | ResponseCancelEvent;

// Server Events
export interface ErrorEvent {
  event_id: string;
  type: 'error';
  error: {
    type: 'invalid_request_error' | 'server_error' | string;
    code: string | null;
    message: string;
    param: string | null;
    event_id: string | null;
  };
}

export interface SessionCreatedEvent {
  event_id: string;
  type: 'session.created';
  session: SessionResource;
}

export interface SessionUpdatedEvent {
  event_id: string;
  type: 'session.updated';
  session: SessionResource;
}

export interface ConversationCreatedEvent {
  event_id: string;
  type: 'conversation.created';
  conversation: ConversationResource;
}

export interface InputAudioBufferCommittedEvent {
  event_id: string;
  type: 'input_audio_buffer.committed';
  item_id: string;
}

export interface InputAudioBufferClearedEvent {
  event_id: string;
  type: 'input_audio_buffer.cleared';
}

export interface InputAudioBufferSpeechStartedEvent {
  event_id: string;
  type: 'input_audio_buffer.speech_started';
  audio_start_ms: number;
  item_id: string;
}

export interface InputAudioBufferSpeechStoppedEvent {
  event_id: string;
  type: 'input_audio_buffer.speech_stopped';
  audio_end_ms: number;
  item_id: string;
}

export interface ConversationItemCreatedEvent {
  event_id: string;
  type: 'item.created';
  item: ItemResource;
}

export interface ConversationItemInputAudioTranscriptionCompletedEvent {
  event_id: string;
  type: 'item.input_audio_transcription.completed';
  item_id: string;
  content_index: number;
  transcript: string;
}

export interface ConversationItemInputAudioTranscriptionFailedEvent {
  event_id: string;
  type: 'item.input_audio_transcription.failed';
  item_id: string;
  content_index: number;
  error: {
    type: string;
    code: string | null;
    message: string;
    param: null;
  };
}

export interface ConversationItemTruncatedEvent {
  event_id: string;
  type: 'conversation.item.truncated';
  item_id: string;
  content_index: number;
  audio_end_ms: number;
}

export interface ConversationItemDeletedEvent {
  event_id: string;
  type: 'conversation.item.deleted';
  item_id: string;
}

export interface ResponseCreatedEvent {
  event_id: string;
  type: 'response.created';
  response: ResponseResource;
}

export interface ResponseDoneEvent {
  event_id: string;
  type: 'response.done';
  response: ResponseResource;
}

export interface ResponseOutputAddedEvent {
  event_id: string;
  type: 'response.output.added';
  response_id: string;
  output_index: number;
  item: ItemResource;
}

export interface ResponseOutputDoneEvent {
  event_id: string;
  type: 'response.output.done';
  response_id: string;
  output_index: number;
  item: ItemResource;
}

export interface ResponseContentAddedEvent {
  event_id: string;
  type: 'response.content.added';
  response_id: string;
  output_index: number;
  content_index: number;
  part: ContentPart;
}

export interface ResponseContentDoneEvent {
  event_id: string;
  type: 'response.content.done';
  response_id: string;
  output_index: number;
  content_index: number;
  part: ContentPart;
}

export interface ResponseTextDeltaEvent {
  event_id: string;
  type: 'response.text.delta';
  response_id: string;
  output_index: number;
  content_index: number;
  delta: string;
}

export interface ResponseTextDoneEvent {
  event_id: string;
  type: 'response.text.done';
  response_id: string;
  output_index: number;
  content_index: number;
  text: string;
}

export interface ResponseAudioTranscriptDeltaEvent {
  event_id: string;
  type: 'response.audio_transcript.delta';
  response_id: string;
  output_index: number;
  content_index: number;
  delta: string;
}

export interface ResponseAudioTranscriptDoneEvent {
  event_id: string;
  type: 'response.audio_transcript.done';
  response_id: string;
  output_index: number;
  content_index: number;
  transcript: string;
}

export interface ResponseAudioDeltaEvent {
  event_id: string;
  type: 'response.audio.delta';
  response_id: string;
  output_index: number;
  content_index: number;
  delta: AudioBase64Bytes;
}

export interface ResponseAudioDoneEvent {
  event_id: string;
  type: 'response.audio.done';
  response_id: string;
  output_index: number;
  content_index: number;
  // 'audio' field is excluded from rendering
}

export interface ResponseFunctionCallArgumentsDeltaEvent {
  event_id: string;
  type: 'response.function_call_arguments.delta';
  response_id: string;
  output_index: number;
  delta: string;
}

export interface ResponseFunctionCallArgumentsDoneEvent {
  event_id: string;
  type: 'response.function_call_arguments.done';
  response_id: string;
  output_index: number;
  arguments: string;
}

export interface RateLimitsUpdatedEvent {
  event_id: string;
  type: 'rate_limits.updated';
  rate_limits: Array<{
    name: 'requests' | 'tokens' | 'input_tokens' | 'output_tokens';
    limit: number;
    remaining: number;
    reset_seconds: number;
  }>;
}

export type ServerEvent =
  | ErrorEvent
  | SessionCreatedEvent
  | SessionUpdatedEvent
  | ConversationCreatedEvent
  | InputAudioBufferCommittedEvent
  | InputAudioBufferClearedEvent
  | InputAudioBufferSpeechStartedEvent
  | InputAudioBufferSpeechStoppedEvent
  | ConversationItemCreatedEvent
  | ConversationItemInputAudioTranscriptionCompletedEvent
  | ConversationItemInputAudioTranscriptionFailedEvent
  | ConversationItemTruncatedEvent
  | ConversationItemDeletedEvent
  | ResponseCreatedEvent
  | ResponseDoneEvent
  | ResponseOutputAddedEvent
  | ResponseOutputDoneEvent
  | ResponseContentAddedEvent
  | ResponseContentDoneEvent
  | ResponseTextDeltaEvent
  | ResponseTextDoneEvent
  | ResponseAudioTranscriptDeltaEvent
  | ResponseAudioTranscriptDoneEvent
  | ResponseAudioDeltaEvent
  | ResponseAudioDoneEvent
  | ResponseFunctionCallArgumentsDeltaEvent
  | ResponseFunctionCallArgumentsDoneEvent
  | RateLimitsUpdatedEvent;

export interface Tool {
  type: 'function';
  name: string;
  description: string | null;
  parameters: JsonSchema;
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
