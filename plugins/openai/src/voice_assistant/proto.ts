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
  ADD_MESSAGE = 'add_message',
  ADD_CONTENT = 'add_content',
  MESSAGE_ADDED = 'message_added',
  VAD_SPEECH_STARTED = 'vad_speech_started',
  VAD_SPEECH_STOPPED = 'vad_speech_stopped',
  INPUT_TRANSCRIBED = 'input_transcribed',
  GENERATION_CANCELED = 'generation_canceled',
  SEND_STATE = 'send_state',
  GENERATION_FINISHED = 'generation_finished',
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
      event: ServerEventType.ADD_MESSAGE;
      previous_id: string;
      conversation_label: string;
      role: 'user' | 'assistant' | 'system' | 'tool';
      message:
        | {
            type: 'text';
            text: string;
          }
        | {
            type: 'tool_call';
            name: string;
            arguments: Map<string, string>;
            tool_call_id: 'string';
          };
    } & {
      role: 'user' | 'tool';
      message: {
        type: 'audio';
        audio: 'audio';
      };
    })
  | {
      event: ServerEventType.ADD_CONTENT;
      item_id: string;
      type: 'text' | 'audio' | 'tool_call_arguments';
      data: string; // text or base64 audio or JSON stringified object
    }
  | {
      event: ServerEventType.MESSAGE_ADDED;
      id: string;
      previous_id: string;
      conversation_label: string;
      content: {
        type: 'tool_call';
        name: string;
        tool_call_id: string;
        arguments: string; // JSON stringified object
      }[];
    }
  | {
      event: ServerEventType.GENERATION_FINISHED;
      reason: 'stop' | 'max_tokens' | 'content_filter' | 'interrupt';
      conversation_label: string;
      message_ids: string[];
    }
  | {
      event: ServerEventType.SEND_STATE;
      session_id: string;
      input_audio_format: 'pcm16' | 'g711-ulaw' | 'g711-alaw';
      vad_active: boolean;
      audio_buffer: string;
      conversations: any; // TODO(nbsp): get this
      session_config: SessionConfig;
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
    }
  | {
      event: ServerEventType.GENERATION_CANCELED;
      item_id: string;
    };

export enum ClientEventType {
  UPDATE_SESSION_CONFIG = 'update_session_config',
  UPDATE_CONVERSATION_CONFIG = 'update_conversation_config',
  ADD_ITEM = 'add_item',
  DELETE_ITEM = 'delete_item',
  ADD_USER_AUDIO = 'add_user_audio',
  COMMIT_USER_AUDIO = 'commit_user_audio',
  CANCEL_GENERATION = 'cancel_generation',
  GENERATE = 'generate',
  CREATE_CONVERSATION = 'create_conversation',
  DELETE_CONVERSATION = 'delete_conversation',
  TRUNCATE_CONTENT = 'truncate_content',
  REQUEST_STATE = 'request_state',
}

export type ClientEvent =
  | ({
      event: ClientEventType.UPDATE_SESSION_CONFIG;
    } & SessionConfig)
  | ({
      event: ClientEventType.UPDATE_CONVERSATION_CONFIG;
    } & ConversationConfig)
  | ({
      event: ClientEventType.ADD_ITEM;
      // id, previous_id, conversation_label are unused by us
    } & (
      | ({
          type: 'message';
        } & (
          | {
              role: 'user' | 'assistant' | 'system';
              content: [
                | {
                    type: 'text';
                    text: string;
                  }
                | {
                    type: 'audio';
                    audio: string; // base64 encoded buffer
                  },
              ];
            }
          | {
              role: 'assistant' | 'system';
              content: [
                {
                  type: 'text';
                  text: string;
                },
              ];
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
      event: ClientEventType.COMMIT_USER_AUDIO | ClientEventType.CANCEL_GENERATION;
    }
  | {
      event: ClientEventType.GENERATE;
      conversation_label?: string; // defaults to 'default'
    }
  | {
      event:
        | ClientEventType.CREATE_CONVERSATION
        | ClientEventType.DELETE_CONVERSATION
        | ClientEventType.REQUEST_STATE;
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

export type SessionConfig = {
  turn_detection: 'disabled' | 'server_vad';
  input_audio_format: 'pcm16' | 'g711-ulaw' | 'g711-alaw';
  transcribe_input: boolean;
  vad: {
    threshold: number; // 0..1 inclusive, default 0.5
    prefix_padding_ms: number; // default 0.5
    silence_duration_ms: number; // default 200
  };
};

export type ConversationConfig = {
  system_message: string;
  voice: Voice;
  subscribe_to_user_audio: boolean;
  output_audio_format: 'pcm16' | 'g711-ulaw' | 'g711-alaw';
  tools: Tool[];
  tool_choice: ToolChoice;
  temperature: number; // 0.6..1.2 inclusive, default 0.8
  max_tokens: number; // 1..4096, default 2048;
  disable_audio: number;
  transcribe_input: boolean;
  conversation_label: string; // default "default"
};

export enum State {
  INITIALIZING = 'initializing',
  LISTENING = 'listening',
  THINKING = 'thinking',
  SPEAKING = 'speaking',
}
