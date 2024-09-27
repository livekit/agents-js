export declare const SAMPLE_RATE = 24000;
export declare const NUM_CHANNELS = 1;
export declare const INPUT_PCM_FRAME_SIZE = 2400;
export declare const OUTPUT_PCM_FRAME_SIZE = 1200;
export declare const API_URL = 'wss://api.openai.com/v1/realtime';
export declare enum Voice {
  ALLOY = 'alloy',
  SHIMMER = 'shimmer',
  ECHO = 'echo',
}
export declare enum AudioFormat {
  PCM16 = 'pcm16',
}
export declare enum Role {
  SYSTEM = 'system',
  ASSISTANT = 'assistant',
  USER = 'user',
  TOOL = 'tool',
}
export declare enum GenerationFinishedReason {
  STOP = 'stop',
  MAX_TOKENS = 'max_tokens',
  CONTENT_FILTER = 'content_filter',
  INTERRUPT = 'interrupt',
}
export declare enum InputTranscriptionModel {
  WHISPER_1 = 'whisper-1',
}
export declare enum Modality {
  TEXT = 'text',
  AUDIO = 'audio',
}
export interface Tool {
  type: 'function';
  name: string;
  description?: string;
  parameters: {
    type: 'object';
    properties: {
      [prop: string]: {
        [prop: string]: any;
      };
    };
    required_properties: string[];
  };
}
export type TurnDetectionType =
  | {
      type: 'server_vad';
      threshold?: number;
      prefix_padding_ms?: number;
      silence_duration_ms?: number;
    }
  | 'none';
export declare enum ToolChoice {
  AUTO = 'auto',
  NONE = 'none',
  REQUIRED = 'required',
}
export declare enum State {
  INITIALIZING = 'initializing',
  LISTENING = 'listening',
  THINKING = 'thinking',
  SPEAKING = 'speaking',
}
export type AudioBase64Bytes = string;
export interface InputTextContent {
  type: 'text';
  text: string;
}
export interface InputAudioContent {
  type: 'input_audio';
  transcript?: string;
}
export interface TextContent {
  type: 'text';
  text: string;
}
export interface AudioContent {
  type: 'audio';
  transcript: string;
}
export type ContentPart = InputTextContent | InputAudioContent | TextContent | AudioContent;
export interface BaseItem {
  id: string;
  object: 'realtime.item';
  previous_item_id?: string;
  type: string;
}
export interface SystemMessageItem extends BaseItem {
  type: 'message';
  role: Role.SYSTEM;
  content: InputTextContent;
}
export interface UserMessageItem extends BaseItem {
  type: 'message';
  role: Role.USER;
  content: (InputTextContent | InputAudioContent)[];
}
export interface AssistantMessageItem extends BaseItem {
  type: 'message';
  role: Role.ASSISTANT;
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
  | SystemMessageItem
  | UserMessageItem
  | AssistantMessageItem
  | FunctionCallItem
  | FunctionCallOutputItem;
export interface SessionResource {
  id: string;
  object: 'realtime.session';
  model: string;
  modalities: ['text', 'audio'] | ['text'];
  instructions?: string;
  voice: Voice;
  input_audio_format: AudioFormat;
  output_audio_format: AudioFormat;
  input_audio_transcription?: {
    model: 'whisper-1';
  };
  turn_detection: TurnDetectionType;
  tools: Tool[];
  tool_choice: ToolChoice;
  temperature: number;
}
export interface ConversationResource {
  id: string;
  object: 'realtime.conversation';
}
export declare enum ResponseStatus {
  IN_PROGRESS = 'in_progress',
  COMPLETED = 'completed',
  INCOMPLETE = 'incomplete',
  CANCELLED = 'cancelled',
  FAILED = 'failed',
}
export type ResponseStatusDetails =
  | {
      type: ResponseStatus.INCOMPLETE;
      reason: 'max_output_tokens' | 'content_filter';
    }
  | {
      type: ResponseStatus.FAILED;
      error?: {
        code: 'server_error' | 'rate_limit_exceeded' | string;
        message: string;
      };
    }
  | {
      type: ResponseStatus.CANCELLED;
      reason: 'turn_detected' | 'client_cancelled';
    };
export interface ResponseResource {
  id: string;
  object: 'realtime.response';
  status: ResponseStatus;
  status_details: ResponseStatusDetails;
  output: ItemResource[];
  usage?: {
    total_tokens: number;
    input_tokens: number;
    output_tokens: number;
  };
}
interface BaseClientEvent {
  event_id?: string;
  type: ClientEventType;
}
export interface SessionUpdateEvent extends BaseClientEvent {
  type: ClientEventType.SessionUpdate;
  session: Partial<{
    modalities: ['text', 'audio'] | ['text'];
    instructions: string;
    voice: Voice;
    input_audio_format: AudioFormat;
    output_audio_format: AudioFormat;
    input_audio_transcription: {
      model: 'whisper-1';
    };
    turn_detection:
      | {
          type: 'server_vad';
          threshold?: number;
          prefix_padding_ms?: number;
          silence_duration_ms?: number;
        }
      | 'none';
    tools: Tool[];
    tool_choice: ToolChoice;
    temperature: number;
    max_output_tokens: number;
  }>;
}
export interface InputAudioBufferAppendEvent extends BaseClientEvent {
  type: ClientEventType.InputAudioBufferAppend;
  audio: AudioBase64Bytes;
}
export interface InputAudioBufferCommitEvent extends BaseClientEvent {
  type: ClientEventType.InputAudioBufferCommit;
}
export interface InputAudioBufferClearEvent extends BaseClientEvent {
  type: ClientEventType.InputAudioBufferClear;
}
export interface ConversationItemCreateEvent extends BaseClientEvent {
  type: ClientEventType.ConversationItemCreate;
  item:
    | {
        type: 'message';
        role: 'user';
        content: (InputTextContent | InputAudioContent)[];
      }
    | {
        type: 'message';
        role: 'assistant';
        content: TextContent[];
      }
    | {
        type: 'message';
        role: 'system';
        content: InputTextContent[];
      }
    | {
        type: 'function_call_output';
        call_id: string;
        output: string;
      };
}
export interface ConversationItemTruncateEvent extends BaseClientEvent {
  type: ClientEventType.ConversationItemTruncate;
  item_id: string;
  content_index: number;
  audio_end_ms: number;
}
export interface ConversationItemDeleteEvent extends BaseClientEvent {
  type: ClientEventType.ConversationItemDelete;
  item_id: string;
}
export interface ResponseCreateEvent extends BaseClientEvent {
  type: ClientEventType.ResponseCreate;
  response?: Partial<{
    modalities: ['text', 'audio'] | ['text'];
    instructions: string;
    voice: Voice;
    output_audio_format: AudioFormat;
    tools?: Tool[];
    tool_choice: ToolChoice;
    temperature: number;
    max_output_tokens: number;
  }>;
}
export interface ResponseCancelEvent extends BaseClientEvent {
  type: ClientEventType.ResponseCancel;
}
export declare enum ClientEventType {
  SessionUpdate = 'session.update',
  InputAudioBufferAppend = 'input_audio_buffer.append',
  InputAudioBufferCommit = 'input_audio_buffer.commit',
  InputAudioBufferClear = 'input_audio_buffer.clear',
  ConversationItemCreate = 'conversation.item.create',
  ConversationItemTruncate = 'conversation.item.truncate',
  ConversationItemDelete = 'conversation.item.delete',
  ResponseCreate = 'response.create',
  ResponseCancel = 'response.cancel',
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
  type: ServerEventType.Error;
  error: {
    type: 'invalid_request_error' | 'server_error' | string;
    code?: string;
    message: string;
    param: string;
    event_id: string;
  };
}
export interface SessionCreatedEvent extends BaseServerEvent {
  type: ServerEventType.SessionCreated;
  session: SessionResource;
}
export interface SessionUpdatedEvent extends BaseServerEvent {
  type: ServerEventType.SessionUpdated;
  session: SessionResource;
}
export interface ConversationCreatedEvent extends BaseServerEvent {
  type: ServerEventType.ConversationCreated;
  conversation: ConversationResource;
}
export interface InputAudioBufferCommittedEvent extends BaseServerEvent {
  type: ServerEventType.InputAudioBufferCommitted;
  item_id: string;
}
export interface InputAudioBufferClearedEvent extends BaseServerEvent {
  type: ServerEventType.InputAudioBufferCleared;
}
export interface InputAudioBufferSpeechStartedEvent extends BaseServerEvent {
  type: ServerEventType.InputAudioBufferSpeechStarted;
  audio_start_ms: number;
  item_id: string;
}
export interface InputAudioBufferSpeechStoppedEvent extends BaseServerEvent {
  type: ServerEventType.InputAudioBufferSpeechStopped;
  audio_end_ms: number;
  item_id: string;
}
export interface ConversationItemCreatedEvent extends BaseServerEvent {
  type: ServerEventType.ConversationItemCreated;
  item: ItemResource;
}
export interface ConversationItemInputAudioTranscriptionCompletedEvent extends BaseServerEvent {
  type: ServerEventType.ConversationItemInputAudioTranscriptionCompleted;
  item_id: string;
  content_index: number;
  transcript: string;
}
export interface ConversationItemInputAudioTranscriptionFailedEvent extends BaseServerEvent {
  type: ServerEventType.ConversationItemInputAudioTranscriptionFailed;
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
  type: ServerEventType.ConversationItemTruncated;
  item_id: string;
  content_index: number;
  audio_end_ms: number;
}
export interface ConversationItemDeletedEvent extends BaseServerEvent {
  type: ServerEventType.ConversationItemDeleted;
  item_id: string;
}
export interface ResponseCreatedEvent extends BaseServerEvent {
  type: ServerEventType.ResponseCreated;
  response: ResponseResource;
}
export interface ResponseDoneEvent extends BaseServerEvent {
  type: ServerEventType.ResponseDone;
  response: ResponseResource;
}
export interface ResponseOutputItemAddedEvent extends BaseServerEvent {
  type: ServerEventType.ResponseOutputItemAdded;
  response_id: string;
  output_index: number;
  item: ItemResource;
}
export interface ResponseOutputItemDoneEvent extends BaseServerEvent {
  type: ServerEventType.ResponseOutputItemDone;
  response_id: string;
  output_index: number;
  item: ItemResource;
}
export interface ResponseContentPartAddedEvent extends BaseServerEvent {
  type: ServerEventType.ResponseContentPartAdded;
  response_id: string;
  item_id: string;
  output_index: number;
  content_index: number;
  part: ContentPart;
}
export interface ResponseContentPartDoneEvent extends BaseServerEvent {
  type: ServerEventType.ResponseContentPartDone;
  response_id: string;
  output_index: number;
  content_index: number;
  part: ContentPart;
}
export interface ResponseTextDeltaEvent extends BaseServerEvent {
  type: ServerEventType.ResponseTextDelta;
  response_id: string;
  output_index: number;
  content_index: number;
  delta: string;
}
export interface ResponseTextDoneEvent extends BaseServerEvent {
  type: ServerEventType.ResponseTextDone;
  response_id: string;
  output_index: number;
  content_index: number;
  text: string;
}
export interface ResponseAudioTranscriptDeltaEvent extends BaseServerEvent {
  type: ServerEventType.ResponseAudioTranscriptDelta;
  response_id: string;
  output_index: number;
  content_index: number;
  delta: string;
}
export interface ResponseAudioTranscriptDoneEvent extends BaseServerEvent {
  type: ServerEventType.ResponseAudioTranscriptDone;
  response_id: string;
  output_index: number;
  content_index: number;
  transcript: string;
}
export interface ResponseAudioDeltaEvent extends BaseServerEvent {
  type: ServerEventType.ResponseAudioDelta;
  response_id: string;
  output_index: number;
  content_index: number;
  delta: AudioBase64Bytes;
}
export interface ResponseAudioDoneEvent extends BaseServerEvent {
  type: ServerEventType.ResponseAudioDone;
  response_id: string;
  output_index: number;
  content_index: number;
}
export interface ResponseFunctionCallArgumentsDeltaEvent extends BaseServerEvent {
  type: ServerEventType.ResponseFunctionCallArgumentsDelta;
  response_id: string;
  output_index: number;
  delta: string;
}
export interface ResponseFunctionCallArgumentsDoneEvent extends BaseServerEvent {
  type: ServerEventType.ResponseFunctionCallArgumentsDone;
  response_id: string;
  output_index: number;
  arguments: string;
}
export interface RateLimitsUpdatedEvent extends BaseServerEvent {
  type: ServerEventType.RateLimitsUpdated;
  rate_limits: {
    name: 'requests' | 'tokens' | 'input_tokens' | 'output_tokens';
    limit: number;
    remaining: number;
    reset_seconds: number;
  }[];
}
export declare enum ServerEventType {
  Error = 'error',
  SessionCreated = 'session.created',
  SessionUpdated = 'session.updated',
  ConversationCreated = 'conversation.created',
  InputAudioBufferCommitted = 'input_audio_buffer.committed',
  InputAudioBufferCleared = 'input_audio_buffer.cleared',
  InputAudioBufferSpeechStarted = 'input_audio_buffer.speech_started',
  InputAudioBufferSpeechStopped = 'input_audio_buffer.speech_stopped',
  ConversationItemCreated = 'conversation.item.created',
  ConversationItemInputAudioTranscriptionCompleted = 'conversation.item.input_audio_transcription.completed',
  ConversationItemInputAudioTranscriptionFailed = 'conversation.item.input_audio_transcription.failed',
  ConversationItemTruncated = 'conversation.item.truncated',
  ConversationItemDeleted = 'conversation.item.deleted',
  ResponseCreated = 'response.created',
  ResponseDone = 'response.done',
  ResponseOutputItemAdded = 'response.output_item.added',
  ResponseOutputItemDone = 'response.output_item.done',
  ResponseContentPartAdded = 'response.content_part.added',
  ResponseContentPartDone = 'response.content_part.done',
  ResponseTextDelta = 'response.text.delta',
  ResponseTextDone = 'response.text.done',
  ResponseAudioTranscriptDelta = 'response.audio_transcript.delta',
  ResponseAudioTranscriptDone = 'response.audio_transcript.done',
  ResponseAudioDelta = 'response.audio.delta',
  ResponseAudioDone = 'response.audio.done',
  ResponseFunctionCallArgumentsDelta = 'response.function_call_arguments.delta',
  ResponseFunctionCallArgumentsDone = 'response.function_call_arguments.done',
  RateLimitsUpdated = 'response.rate_limits.updated',
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
export {};
//# sourceMappingURL=api_proto.d.ts.map
