// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { log } from '@livekit/agents';
import { AudioFrame } from '@livekit/rtc-node';
import { URL } from 'url';
import { type RawData, WebSocket } from 'ws';

enum Voice {
  alloy = 'alloy',
  shimmer = 'shimmer',
  echo = 'echo',
}

enum TurnEndType {
  serverDetection = 'server_detection',
  clientDecision = 'client_decision',
}

enum AudioFormat {
  pcm16 = 'pcm16',
  // g711_ulaw = 'g711-ulaw',
  // g711_alaw = 'g711-alaw',
}

enum ServerEvent {
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

enum ClientEvent {
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

const API_URL = 'wss://api.openai.com/v1/realtime';
const SAMPLE_RATE = 24000;
const NUM_CHANNELS = 1;

const INPUT_PCM_FRAME_SIZE = 2400; // 100ms
const OUTPUT_PCM_FRAME_SIZE = 1200; // 50ms

type InferenceConfig = {
  systemMessage: string;
  voice: Voice;
  maxTokens: number;
  temperature: number;
  disableAudio: boolean;
  turnEndType: TurnEndType;
  transcribeInput: boolean;
  audioFormat: AudioFormat;
  // TODO: tools and tool_choice
};

const defaultInferenceConfig: InferenceConfig = {
  systemMessage: 'You are a helpful assistant.',
  voice: Voice.alloy,
  maxTokens: 2048,
  temperature: 0.8,
  disableAudio: false,
  turnEndType: TurnEndType.serverDetection,
  transcribeInput: true,
  audioFormat: AudioFormat.pcm16,
};

type ImplOptions = {
  apiKey: string;
  inferenceConfig: InferenceConfig;
};

export class VoiceAssistant {
  options: ImplOptions;

  constructor(apiKey?: string, inferenceConfig: InferenceConfig = defaultInferenceConfig) {
    apiKey = apiKey || process.env.OPENAI_API_KEY;
    if (apiKey === undefined) {
      throw new Error('OpenAI API key is required, whether as an argument or as $OPENAI_API_KEY');
    }

    this.options = {
      apiKey,
      inferenceConfig,
    };
  }

  private ws: WebSocket | null = null;
  private isConnected: boolean = false;

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.isConnected) {
        resolve();
        return;
      }

      this.ws = new WebSocket(API_URL, {
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`
        }
      });

      this.ws.onopen = () => {
        this.isConnected = true;
        this.sendClientCommand({
          event: ClientEvent.setInferenceConfig,
          ...this.options.inferenceConfig,
        });
        resolve();
      };

      this.ws.onerror = (error) => {
        reject(error);
      };

      this.ws.onclose = () => {
        this.isConnected = false;
        this.ws = null;
      };

      this.ws.onmessage = (event) => {
        this.handleServerCommand(JSON.parse(event.data as string));
      };
    });
  }

  private sendClientCommand(command: Record<string, unknown>): void {
    if (!this.isConnected || !this.ws) {
      throw new Error('WebSocket is not connected');
    }
    console.log('sendClientCommand', JSON.stringify(command));
    this.ws.send(JSON.stringify(command));
  }

  private handleServerCommand(command: Record<string, unknown>): void {
    console.log('handleServerCommand', command);
    // Handle different types of server commands here
    // switch (command.type) {
    //   case 'audio':
    //     // Handle audio data
    //     break;
    //   case 'text':
    //     // Handle text data
    //     break;
    //   // Add more cases as needed
    //   default:
    //     console.warn('Unknown server command:', command);
    // }
  }
}
