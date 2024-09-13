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

export enum ServerEventType {
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

export type ServerEvent =
  | {
      event: ServerEventType.START_SESSION;
      session_id: string;
      model: string;
      system_fingerprint: string;
    }
  | {
      event: ServerEventType.ERROR;
      error: string;
    }
  | ({
      event: ServerEventType.ADD_ITEM;
      id: string;
      previous_id: string;
      conversation_label: string;
    } & (
      | {
          type: 'message';
        }
      | { type: 'tool_call'; tool_call_id: string; name: string }
    ))
  | {
      event: ServerEventType.ADD_CONTENT;
      item_id: string;
      type: 'text' | 'audio' | 'tool_call_arguments';
      data: string; // text or base64 audio or JSON stringified object
    }
  | ({
      event: ServerEventType.ITEM_ADDED;
      id: string;
      previous_id: string;
      conversation_label: string;
    } & (
      | { type: 'message' }
      | {
          type: 'tool_call';
          name: string;
          tool_call_id: string;
          arguments: string; // JSON stringified object
        }
    ))
  | {
      event: ServerEventType.TURN_FINISHED;
      reason: 'stop' | 'max_tokens' | 'content_filter' | 'interrupt';
      conversation_label: string;
      item_ids: string[];
    }
  | {
      event: ServerEventType.VAD_SPEECH_STARTED | ServerEventType.VAD_SPEECH_STOPPED;
      sample_index: number;
      item_id: string;
    }
  | {
      event: ServerEventType.INPUT_TRANSCRIBED;
      item_id: string;
      transcript: string;
    };

export enum ClientEventType {
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

export type ClientEvent =
  | ({
      event: ClientEventType.SET_INFERENCE_CONFIG;
    } & InferenceConfig)
  | ({
      event: ClientEventType.ADD_ITEM;
      // id, previous_id, conversation_label are unused by us
    } & (
      | ({
          type: 'message';
          role: 'user' | 'assistant' | 'system';
        } & (
          | {
              role: 'assistant' | 'system' | 'user';
              content: {
                type: 'text';
                text: string;
              };
            }
          | {
              role: 'user';
              content: {
                type: 'audio';
                audio: 'string'; // base64 encoded buffer
              };
            }
        ))
      | {
          type: 'tool_response';
          tool_call_id: string;
          content: string;
        }
      | {
          type: 'tool_call';
          name: 'string';
          arguments: Record<string, Record<string, unknown>>;
        }
    ))
  | {
      event: ClientEventType.DELETE_ITEM;
      id: string;
      conversation_label?: string; // defaults to 'default'
    }
  | {
      event: ClientEventType.ADD_USER_AUDIO;
      data: string; // base64 encoded buffer
    }
  | {
      event:
        | ClientEventType.COMMIT_PENDING_AUDIO
        | ClientEventType.CLIENT_TURN_FINISHED
        | ClientEventType.CLIENT_INTERRUPTED;
    }
  | {
      event: ClientEventType.GENERATE;
      conversation_label?: string; // defaults to 'default'
    }
  | {
      event:
        | ClientEventType.CREATE_CONVERSATION
        | ClientEventType.DELETE_CONVERSATION
        | ClientEventType.SUBSCRIBE_TO_USER_AUDIO
        | ClientEventType.UNSUBSCRIBE_FROM_USER_AUDIO;
      label: string;
    }
  | {
      event: ClientEventType.TRUNCATE_CONTENT;
      message_id: string;
      index: number; // integer, ignored
      text_chars?: number; // integer
      audio_samples?: number; // integer
    };

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
