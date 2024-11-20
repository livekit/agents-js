// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

export const SAMPLE_RATE = 24000;
export const NUM_CHANNELS = 1;
export const IN_FRAME_SIZE = 2400; // 100ms
export const OUT_FRAME_SIZE = 1200; // 50ms

export const BASE_URL = 'wss://api.openai.com/v1';

export type Model = 'gpt-4o-realtime-preview-2024-10-01' | string; // Open-ended, for future models
export type Voice =
  | 'alloy'
  | 'shimmer'
  | 'echo'
  | 'ash'
  | 'ballad'
  | 'coral'
  | 'sage'
  | 'verse'
  | string;
export type AudioFormat = 'pcm16'; // TODO: 'g711-ulaw' | 'g711-alaw'
export type Role = 'system' | 'assistant' | 'user' | 'tool';
export type GenerationFinishedReason = 'stop' | 'max_tokens' | 'content_filter' | 'interrupt';
export type InputTranscriptionModel = 'whisper-1' | string; // Open-ended, for future models
export type Modality = 'text' | 'audio';
export type ToolChoice = 'auto' | 'none' | 'required' | string;
export type State = 'initializing' | 'listening' | 'thinking' | 'speaking' | string;
export type ResponseStatus =
  | 'in_progress'
  | 'completed'
  | 'incomplete'
  | 'cancelled'
  | 'failed'
  | string;
export type ClientEventType =
  | 'session.update'
  | 'input_audio_buffer.append'
  | 'input_audio_buffer.commit'
  | 'input_audio_buffer.clear'
  | 'conversation.item.create'
  | 'conversation.item.truncate'
  | 'conversation.item.delete'
  | 'response.create'
  | 'response.cancel';
export type ServerEventType =
  | 'error'
  | 'session.created'
  | 'session.updated'
  | 'conversation.created'
  | 'input_audio_buffer.committed'
  | 'input_audio_buffer.cleared'
  | 'input_audio_buffer.speech_started'
  | 'input_audio_buffer.speech_stopped'
  | 'conversation.item.created'
  | 'conversation.item.input_audio_transcription.completed'
  | 'conversation.item.input_audio_transcription.failed'
  | 'conversation.item.truncated'
  | 'conversation.item.deleted'
  | 'response.created'
  | 'response.done'
  | 'response.output_item.added'
  | 'response.output_item.done'
  | 'response.content_part.added'
  | 'response.content_part.done'
  | 'response.text.delta'
  | 'response.text.done'
  | 'response.audio_transcript.delta'
  | 'response.audio_transcript.done'
  | 'response.audio.delta'
  | 'response.audio.done'
  | 'response.function_call_arguments.delta'
  | 'response.function_call_arguments.done'
  | 'rate_limits.updated';

export type AudioBase64Bytes = string;

export interface Tool {
  type: 'function';
  name: string;
  description?: string;
  parameters: {
    type: 'object';
    properties: {
      [prop: string]: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        [prop: string]: any;
      };
    };
    required: string[];
  };
}

export type TurnDetectionType = {
  type: 'server_vad';
  threshold?: number; // 0.0 to 1.0, default: 0.5
  prefix_padding_ms?: number; // default: 300
  silence_duration_ms?: number; // default: 200
};

export type InputAudioTranscription = {
  model: InputTranscriptionModel;
};

export interface InputTextContent {
  type: 'input_text';
  text: string;
}

export interface InputAudioContent {
  type: 'input_audio';
  audio: AudioBase64Bytes;
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

export type Content = InputTextContent | InputAudioContent | TextContent | AudioContent;
export type ContentPart = {
  type: 'text' | 'audio';
  audio?: AudioBase64Bytes;
  transcript?: string;
};

export interface BaseItem {
  id: string;
  object: 'realtime.item';
  type: string;
}

export interface SystemItem extends BaseItem {
  type: 'message';
  role: 'system';
  content: InputTextContent;
}

export interface UserItem extends BaseItem {
  type: 'message';
  role: 'user';
  content: (InputTextContent | InputAudioContent)[];
}

export interface AssistantItem extends BaseItem {
  type: 'message';
  role: 'assistant';
  content: (TextContent | AudioContent)[];
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
  | SystemItem
  | UserItem
  | AssistantItem
  | FunctionCallItem
  | FunctionCallOutputItem;

// Session Resource
export interface SessionResource {
  id: string;
  object: 'realtime.session';
  model: string;
  modalities: ['text', 'audio'] | ['text']; // default: ["text", "audio"]
  instructions: string;
  voice: Voice; // default: "alloy"
  input_audio_format: AudioFormat; // default: "pcm16"
  output_audio_format: AudioFormat; // default: "pcm16"
  input_audio_transcription: InputAudioTranscription | null;
  turn_detection: TurnDetectionType | null;
  tools: Tool[];
  tool_choice: ToolChoice; // default: "auto"
  temperature: number; // default: 0.8
  max_response_output_tokens: number | 'inf';
  expires_at: number;
}

// Conversation Resource
export interface ConversationResource {
  id: string;
  object: 'realtime.conversation';
}

export type ResponseStatusDetails =
  | {
      type: 'incomplete';
      reason: 'max_output_tokens' | 'content_filter' | string;
    }
  | {
      type: 'failed';
      error?: {
        code: 'server_error' | 'rate_limit_exceeded' | string;
        message: string;
      };
    }
  | {
      type: 'cancelled';
      reason: 'turn_detected' | 'client_cancelled' | string;
    };

export interface ModelUsage {
  total_tokens: number;
  input_tokens: number;
  output_tokens: number;
  input_token_details: {
    text_tokens: number;
    audio_tokens: number;
    cached_tokens: number;
    cached_tokens_details: {
      text_tokens: number;
      audio_tokens: number;
    };
  };
  output_token_details: {
    text_tokens: number;
    audio_tokens: number;
  };
}

export interface ResponseResource {
  id: string;
  object: 'realtime.response';
  status: ResponseStatus;
  status_details: ResponseStatusDetails;
  output: ItemResource[];
  usage?: ModelUsage;
}

// Client Events
interface BaseClientEvent {
  event_id?: string;
  type: ClientEventType;
}

export interface SessionUpdateEvent extends BaseClientEvent {
  type: 'session.update';
  session: Partial<{
    modalities: ['text', 'audio'] | ['text'];
    instructions: string;
    voice: Voice;
    input_audio_format: AudioFormat;
    output_audio_format: AudioFormat;
    input_audio_transcription: InputAudioTranscription | null;
    turn_detection: TurnDetectionType | null;
    tools: Tool[];
    tool_choice: ToolChoice;
    temperature: number;
    max_response_output_tokens?: number | 'inf';
  }>;
}

export interface InputAudioBufferAppendEvent extends BaseClientEvent {
  type: 'input_audio_buffer.append';
  audio: AudioBase64Bytes;
}

export interface InputAudioBufferCommitEvent extends BaseClientEvent {
  type: 'input_audio_buffer.commit';
}

export interface InputAudioBufferClearEvent extends BaseClientEvent {
  type: 'input_audio_buffer.clear';
}

export interface UserItemCreate {
  type: 'message';
  role: 'user';
  content: (InputTextContent | InputAudioContent)[];
}

export interface AssistantItemCreate {
  type: 'message';
  role: 'assistant';
  content: TextContent[];
}

export interface SystemItemCreate {
  type: 'message';
  role: 'system';
  content: InputTextContent[];
}

export interface FunctionCallOutputItemCreate {
  type: 'function_call_output';
  call_id: string;
  output: string;
}

export type ConversationItemCreateContent =
  | UserItemCreate
  | AssistantItemCreate
  | SystemItemCreate
  | FunctionCallOutputItemCreate;

export interface ConversationItemCreateEvent extends BaseClientEvent {
  type: 'conversation.item.create';
  previous_item_id?: string;
  item: ConversationItemCreateContent;
}

export interface ConversationItemTruncateEvent extends BaseClientEvent {
  type: 'conversation.item.truncate';
  item_id: string;
  content_index: number;
  audio_end_ms: number;
}

export interface ConversationItemDeleteEvent extends BaseClientEvent {
  type: 'conversation.item.delete';
  item_id: string;
}

export interface ResponseCreateEvent extends BaseClientEvent {
  type: 'response.create';
  response?: Partial<{
    modalities: ['text', 'audio'] | ['text'];
    instructions: string;
    voice: Voice;
    output_audio_format: AudioFormat;
    tools?: Tool[];
    tool_choice: ToolChoice;
    temperature: number;
    max_output_tokens: number | 'inf';
  }>;
}

export interface ResponseCancelEvent extends BaseClientEvent {
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

interface BaseServerEvent {
  event_id: string;
  type: ServerEventType;
}

export interface ErrorEvent extends BaseServerEvent {
  type: 'error';
  error: {
    type: 'invalid_request_error' | 'server_error' | string;
    code?: string;
    message: string;
    param: string;
    event_id: string;
  };
}

export interface SessionCreatedEvent extends BaseServerEvent {
  type: 'session.created';
  session: SessionResource;
}

export interface SessionUpdatedEvent extends BaseServerEvent {
  type: 'session.updated';
  session: SessionResource;
}

export interface ConversationCreatedEvent extends BaseServerEvent {
  type: 'conversation.created';
  conversation: ConversationResource;
}

export interface InputAudioBufferCommittedEvent extends BaseServerEvent {
  type: 'input_audio_buffer.committed';
  item_id: string;
}

export interface InputAudioBufferClearedEvent extends BaseServerEvent {
  type: 'input_audio_buffer.cleared';
}

export interface InputAudioBufferSpeechStartedEvent extends BaseServerEvent {
  type: 'input_audio_buffer.speech_started';
  audio_start_ms: number;
  item_id: string;
}

export interface InputAudioBufferSpeechStoppedEvent extends BaseServerEvent {
  type: 'input_audio_buffer.speech_stopped';
  audio_end_ms: number;
  item_id: string;
}

export interface ConversationItemCreatedEvent extends BaseServerEvent {
  type: 'conversation.item.created';
  item: ItemResource;
}

export interface ConversationItemInputAudioTranscriptionCompletedEvent extends BaseServerEvent {
  type: 'conversation.item.input_audio_transcription.completed';
  item_id: string;
  content_index: number;
  transcript: string;
}

export interface ConversationItemInputAudioTranscriptionFailedEvent extends BaseServerEvent {
  type: 'conversation.item.input_audio_transcription.failed';
  item_id: string;
  content_index: number;
  error: {
    type: string;
    code?: string;
    message: string;
    param: null;
  };
}

export interface ConversationItemTruncatedEvent extends BaseServerEvent {
  type: 'conversation.item.truncated';
  item_id: string;
  content_index: number;
  audio_end_ms: number;
}

export interface ConversationItemDeletedEvent extends BaseServerEvent {
  type: 'conversation.item.deleted';
  item_id: string;
}

export interface ResponseCreatedEvent extends BaseServerEvent {
  type: 'response.created';
  response: ResponseResource;
}

export interface ResponseDoneEvent extends BaseServerEvent {
  type: 'response.done';
  response: ResponseResource;
}

export interface ResponseOutputItemAddedEvent extends BaseServerEvent {
  type: 'response.output_item.added';
  response_id: string;
  output_index: number;
  item: ItemResource;
}

export interface ResponseOutputItemDoneEvent extends BaseServerEvent {
  type: 'response.output_item.done';
  response_id: string;
  output_index: number;
  item: ItemResource;
}

export interface ResponseContentPartAddedEvent extends BaseServerEvent {
  type: 'response.content_part.added';
  response_id: string;
  item_id: string;
  output_index: number;
  content_index: number;
  part: ContentPart;
}

export interface ResponseContentPartDoneEvent extends BaseServerEvent {
  type: 'response.content_part.done';
  response_id: string;
  output_index: number;
  content_index: number;
  part: ContentPart;
}

export interface ResponseTextDeltaEvent extends BaseServerEvent {
  type: 'response.text.delta';
  response_id: string;
  output_index: number;
  content_index: number;
  delta: string;
}

export interface ResponseTextDoneEvent extends BaseServerEvent {
  type: 'response.text.done';
  response_id: string;
  output_index: number;
  content_index: number;
  text: string;
}

export interface ResponseAudioTranscriptDeltaEvent extends BaseServerEvent {
  type: 'response.audio_transcript.delta';
  response_id: string;
  output_index: number;
  content_index: number;
  delta: string;
}

export interface ResponseAudioTranscriptDoneEvent extends BaseServerEvent {
  type: 'response.audio_transcript.done';
  response_id: string;
  output_index: number;
  content_index: number;
  transcript: string;
}

export interface ResponseAudioDeltaEvent extends BaseServerEvent {
  type: 'response.audio.delta';
  response_id: string;
  output_index: number;
  content_index: number;
  delta: AudioBase64Bytes;
}

export interface ResponseAudioDoneEvent extends BaseServerEvent {
  type: 'response.audio.done';
  response_id: string;
  output_index: number;
  content_index: number;
}

export interface ResponseFunctionCallArgumentsDeltaEvent extends BaseServerEvent {
  type: 'response.function_call_arguments.delta';
  response_id: string;
  output_index: number;
  delta: string;
}

export interface ResponseFunctionCallArgumentsDoneEvent extends BaseServerEvent {
  type: 'response.function_call_arguments.done';
  response_id: string;
  output_index: number;
  arguments: string;
}

export interface RateLimitsUpdatedEvent extends BaseServerEvent {
  type: 'rate_limits.updated';
  rate_limits: {
    name: 'requests' | 'tokens' | 'input_tokens' | 'output_tokens' | string;
    limit: number;
    remaining: number;
    reset_seconds: number;
  }[];
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
  | ResponseOutputItemAddedEvent
  | ResponseOutputItemDoneEvent
  | ResponseContentPartAddedEvent
  | ResponseContentPartDoneEvent
  | ResponseTextDeltaEvent
  | ResponseTextDoneEvent
  | ResponseAudioTranscriptDeltaEvent
  | ResponseAudioTranscriptDoneEvent
  | ResponseAudioDeltaEvent
  | ResponseAudioDoneEvent
  | ResponseFunctionCallArgumentsDeltaEvent
  | ResponseFunctionCallArgumentsDoneEvent
  | RateLimitsUpdatedEvent;
