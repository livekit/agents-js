// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
// import { log } from '@livekit/agents';
import { AudioStream, TrackSource, AudioStreamEvent, AudioFrameEvent, RoomEvent, Room, RemoteAudioTrack, RemoteParticipant } from '@livekit/rtc-node';
import { WebSocket } from 'ws';

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
  room: Room | null = null;
  linkedParticipant: RemoteParticipant | null = null;
  subscribedTrack: RemoteAudioTrack | null = null;
  readMicroTask: { promise: Promise<void>; cancel: () => void } | null = null;

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
  private connected: boolean = false;
  // private room: Room;
  private participant: RemoteParticipant | string | null = null;
  // private linkedParticipant: RemoteParticipant | null = null;
  // private subscribedTrack: RemoteAudioTrack | null = null;

  start(room: Room, participant: RemoteParticipant | string | null = null): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.ws !== null) {
        console.log('VoiceAssistant already started');
        resolve();
        return;
      }

      room.on(RoomEvent.ParticipantConnected, (participant: RemoteParticipant) => {
        if (!this.linkedParticipant) {
          return;
        }

        this.linkParticipant(participant.identity);
      });

      this.room = room;
      this.participant = participant;

      if (participant) {
        if (typeof participant === 'string') {
          this.linkParticipant(participant);
        } else {
          this.linkParticipant(participant.identity);
        }
      } else {
        // No participant specified, try to find the first participant in the room
        for (const participant of room.remoteParticipants.values()) {
          this.linkParticipant(participant.identity);
          break;
        }
      }

      this.ws = new WebSocket(API_URL, {
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
        },
      });

      this.ws.onopen = () => {
        this.connected = true;
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
        this.connected = false;
        this.ws = null;
      };

      this.ws.onmessage = (event) => {
        this.handleServerCommand(JSON.parse(event.data as string));
      };
    });
  }

  private sendClientCommand(command: Record<string, unknown>): void {
    if (!this.connected || !this.ws) {
      console.error('WebSocket is not connected');
      return;
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

  private linkParticipant(participantIdentity: string): void {
    if (!this.room) {
      console.error('Room is not set');
      return;
    }

    this.linkedParticipant = this.room.remoteParticipants.get(participantIdentity) || null;
    if (!this.linkedParticipant) {
      console.error(`Participant with identity ${participantIdentity} not found`);
      return;
    }
    this.subscribeToMicrophone();
  }

  private subscribeToMicrophone(): void {
    const readAudioStreamTask = async (audioStream: AudioStream) => {
      audioStream.on(AudioStreamEvent.FrameReceived, (ev: AudioFrameEvent) => {
        const audioData = ev.frame.data;
        const base64Audio = Buffer.from(audioData.buffer).toString('base64');
        this.sendClientCommand({
          event: ClientEvent.addUserAudio,
          data: base64Audio,
        });
      });
    };

    if (!this.linkedParticipant) {
      console.error('Participant is not set');
      return;
    }

    for (const publication of this.linkedParticipant.trackPublications.values()) {
      if (publication.source !== TrackSource.SOURCE_MICROPHONE) {
        continue;
      }

      if (!publication.subscribed) {
        publication.setSubscribed(true);
      }

      const track = publication.track;

      if (track && track !== this.subscribedTrack) {
        this.subscribedTrack = track as RemoteAudioTrack;
        if (this.readMicroTask) {
          this.readMicroTask.cancel();
        }

        let cancel: () => void;
        this.readMicroTask = {
          promise: new Promise<void>((resolve, reject) => {
            cancel = () => {
              // Cleanup logic here
              reject(new Error('Task cancelled'));
            };
            readAudioStreamTask(new AudioStream(track, SAMPLE_RATE, NUM_CHANNELS))
              .then(resolve)
              .catch(reject);
          }),
          cancel: () => cancel(),
        };
      }
    }
  }
}
