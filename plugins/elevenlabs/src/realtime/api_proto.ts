// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

export const BASE_URL = 'wss://api.elevenlabs.io/v1/convai/conversation';
export const AUTHORIZATION_HEADER = 'xi-api-key';

export const DEFAULT_SAMPLE_RATE = 16000;
export const NUM_CHANNELS = 1;
export const DEFAULT_IN_FRAME_SIZE = 1600; // 100ms
export const DEFAULT_OUT_FRAME_SIZE = 800; // 50ms

export type AudioFormat = string; //'pcm_16000' | 'pcm_22050' | 'pcm_44100'
export type ContentType = 'audio';

export type ClientEventType =
  | 'user_audio_chunk'
  | 'pong'
  | 'conversation_initiation_client_data'
  | 'client_tool_result' //TODO: Add support
  | 'contextual_update'; //TODO: Add support
export type ServerEventType =
  | 'conversation_initiation_metadata'
  | 'user_transcript'
  | 'agent_response'
  | 'agent_response_correction'
  | 'audio'
  | 'interruption'
  | 'ping'
  | 'client_tool_call' //TODO: Add support
  | 'contextual_update' //TODO: Add support
  | 'vad_score'
  | 'internal_tentative_agent_response';

export type AudioBase64Bytes = string;

interface BaseClientEvent {
  type: ClientEventType;
}

export interface UserAudioChunkEvent extends BaseClientEvent {
  type: 'user_audio_chunk';
  audio: AudioBase64Bytes;
}

export interface PongEvent extends BaseClientEvent {
  type: 'pong';
  event_id: number; //The id of the ping event being responded to
}

export interface ConversationInitiationClientDataEvent extends BaseClientEvent {
  type: 'conversation_initiation_client_data';
  conversation_config_override?: {
    agent?: {
      prompt?: {
        prompt?: string;
      };
      first_message?: string;
      language?: string;
    };
    tts?: {
      voice_id?: string;
    };
  };
  custom_llm_extra_body?: {
    temperature?: number;
    max_tokenx?: number;
  };
  dynamic_variables?: Record<string, string | number | boolean>;
}

// This is only used for client-side tools
// see: https://elevenlabs.io/docs/conversational-ai/customization/tools/client-tools
export interface ClientToolResultEvent extends BaseClientEvent {
  type: 'client_tool_result';
  tool_call_id?: string; //Id of the tool call being responded to
  result?: string;
  is_error: boolean;
}

export interface ContextualUpdateEvent extends BaseClientEvent {
  type: 'contextual_update';
  text: string; //Contextual information to be added to the conversation state
}

export type ClientEvent =
  | UserAudioChunkEvent
  | PongEvent
  | ConversationInitiationClientDataEvent
  | ClientToolResultEvent
  | ContextualUpdateEvent;

interface BaseServerEvent {
  type: ServerEventType;
}

export interface ConversationInitiationMetadataEvent extends BaseServerEvent {
  type: 'conversation_initiation_metadata';
  conversation_id: string;
  agent_output_audio_format: AudioFormat;
  user_input_audio_format: AudioFormat;
}

export interface UserTranscriptEvent extends BaseServerEvent {
  type: 'user_transcript';
  user_transcription_event: {
    user_transcript?: string;
  };
}

export interface AgentResponseEvent extends BaseServerEvent {
  type: 'agent_response';
  agent_response_event: {
    agent_response: string;
  };
}

export interface AgentResponseCorrectionEvent extends BaseServerEvent {
  type: 'agent_response_correction';
  correction_event: {
    corrected_response: string;
  };
}

export interface AudioResponseEvent extends BaseServerEvent {
  type: 'audio';
  audio_event: {
    audio_base_64: AudioBase64Bytes;
    event_id: number; //Sequential identifier for the audio chunk
  };
}

export interface InterruptionEvent extends BaseServerEvent {
  type: 'interruption';
  interruption_event?: {
    event_id: number; //Id of the event that was interrupted
  };
}

export interface PingEvent extends BaseServerEvent {
  type: 'ping';
  ping_event: {
    event_id: number;
    ping_ms?: number; //Measured round-trip latency in ms
  };
}

export interface ClientToolCallEvent extends BaseServerEvent {
  type: 'client_tool_call';
  client_tool_call: {
    tool_name: string;
    tool_call_id: string;
    parameters?: Record<string, never>;
  };
}

export interface ContextualUpdateServerEvent extends BaseServerEvent {
  type: 'contextual_update';
  text: string; //Contextual information to be added to the conversation state
}

export interface VadScoreEvent extends BaseServerEvent {
  type: 'vad_score';
  vad_score_event: {
    vad_score: number; // VAD confidence score between 0 and 1
  };
}

export interface InternalTentativeAgentResponseEvent extends BaseServerEvent {
  type: 'internal_tentative_agent_response';
  internal_tentative_agent_response_event: {
    tentative_agent_response: string; // Preliminary text from the agent
  };
}

export type ServerEvent =
  | ConversationInitiationMetadataEvent
  | UserTranscriptEvent
  | AgentResponseEvent
  | AgentResponseCorrectionEvent
  | AudioResponseEvent
  | InterruptionEvent
  | PingEvent
  | ClientToolCallEvent
  | ContextualUpdateServerEvent
  | VadScoreEvent
  | InternalTentativeAgentResponseEvent;
