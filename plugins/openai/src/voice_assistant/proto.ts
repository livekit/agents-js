// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
export enum Voice {
  ALLOY = 'alloy',
  SHIMMER = 'shimmer',
  ECHO = 'echo',
}

export enum TurnEndType {
  SERVER_DETECTION = 'server_detection',
  CLIENT_DECISION = 'client_decision',
}

export enum AudioFormat {
  PCM16 = 'pcm16',
  // G711_ULAW = 'g711-ulaw',
  // G711_ALAW = 'g711-alaw',
}

export enum ServerEvent {
  START_SESSION = 'start_session',
  ERROR = 'error',
  ADD_ITEM = 'add_item',
  ADD_CONTENT = 'add_content',
  ITEM_ADDED = 'item_added',
  TURN_FINISHED = 'turn_finished',
  VAD_SPEECH_STARTED = 'vad_speech_started',
  VAD_SPEECH_STOPPED = 'vad_speech_stopped',
  INPUT_TRANSCRIBED = 'input_transcribed',
  MODEL_LISTENING = 'model_listening',
}

export enum ClientEvent {
  SET_INFERENCE_CONFIG = 'set_inference_config',
  ADD_ITEM = 'add_item',
  DELETE_ITEM = 'delete_item',
  ADD_USER_AUDIO = 'add_user_audio',
  COMMIT_PENDING_AUDIO = 'commit_pending_audio',
  CLIENT_TURN_FINISHED = 'client_turn_finished',
  CLIENT_INTERRUPTED = 'client_interrupted',
  GENERATE = 'generate',
  CREATE_CONVERSATION = 'create_conversation',
  DELETE_CONVERSATION = 'delete_conversation',
  SUBSCRIBE_TO_USER_AUDIO = 'subscribe_to_user_audio',
  UNSUBSCRIBE_FROM_USER_AUDIO = 'unsubscribe_from_user_audio',
  TRUNCATE_CONTENT = 'truncate_content',
}

export enum ToolChoice {
  AUTO = 'auto',
  NONE = 'none',
  REQUIRED = 'required',
}

export interface Tool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: {
        [prop: string]: {
          [prop: string]: any;
        };
      };
      required_properties: string[];
    };
  };
}

export const API_URL = 'wss://api.openai.com/v1/realtime';
export const SAMPLE_RATE = 24000;
export const NUM_CHANNELS = 1;

export const INPUT_PCM_FRAME_SIZE = 2400; // 100ms
export const OUTPUT_PCM_FRAME_SIZE = 1200; // 50ms

export type InferenceConfig = {
  system_message: string;
  voice: Voice;
  max_tokens: number;
  temperature: number;
  disable_audio: boolean;
  turn_end_type: TurnEndType;
  transcribe_input: boolean;
  audio_format: AudioFormat;
  tools: Tool[];
  tool_choice: ToolChoice;
};

export enum State {
  INITIALIZING = 'initializing',
  LISTENING = 'listening',
  THINKING = 'thinking',
  SPEAKING = 'speaking',
}
