// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
export enum Voice {
  alloy = 'alloy',
  shimmer = 'shimmer',
  echo = 'echo',
}

export enum TurnEndType {
  serverDetection = 'server_detection',
  clientDecision = 'client_decision',
}

export enum AudioFormat {
  pcm16 = 'pcm16',
  // g711_ulaw = 'g711-ulaw',
  // g711_alaw = 'g711-alaw',
}

export enum ServerEvent {
  startSession = 'start_session',
  error = 'error',
  addItem = 'add_item',
  addContent = 'add_content',
  itemAdded = 'item_added',
  turnFinished = 'turn_finished',
  vadSpeechStarted = 'vad_speech_started',
  vadSpeechStopped = 'vad_speech_stopped',
  inputTranscribed = 'input_transcribed',
}

export enum ClientEvent {
  setInferenceConfig = 'set_inference_config',
  addItem = 'add_item',
  deleteItem = 'delete_item',
  addUserAudio = 'add_user_audio',
  commitPendingAudio = 'commit_pending_audio',
  clientTurnFinished = 'client_turn_finished',
  clientInterrupted = 'client_interrupted',
  generate = 'generate',
  createConversation = 'create_conversation',
  deleteConversation = 'delete_conversation',
  subscribeToUserAudio = 'subscribe_to_user_audio',
  unsubscribeFromUserAudio = 'unsubscribe_from_user_audio',
  truncateContent = 'truncate_content',
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
  // TODO: tools and tool_choice
};
