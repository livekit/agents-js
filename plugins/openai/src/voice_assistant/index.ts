// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
// import { log } from '@livekit/agents';
import { AudioByteStream } from '@livekit/agents';
import type { AudioFrameEvent, RemoteAudioTrack, RemoteParticipant, Room } from '@livekit/rtc-node';
import {
  AudioFrame,
  AudioSource,
  AudioStream,
  AudioStreamEvent,
  LocalAudioTrack,
  RoomEvent,
  TrackPublishOptions,
  TrackSource,
} from '@livekit/rtc-node';
import { WebSocket } from 'ws';
import * as proto from './proto.js';

const defaultInferenceConfig: proto.InferenceConfig = {
  system_message: 'You are a helpful assistant.',
  voice: proto.Voice.alloy,
  max_tokens: 2048,
  temperature: 0.8,
  disable_audio: false,
  turn_end_type: proto.TurnEndType.serverDetection,
  transcribe_input: true,
  audio_format: proto.AudioFormat.pcm16,
};

type ImplOptions = {
  apiKey: string;
  inferenceConfig: proto.InferenceConfig;
};

export class VoiceAssistant {
  options: ImplOptions;
  room: Room | null = null;
  linkedParticipant: RemoteParticipant | null = null;
  subscribedTrack: RemoteAudioTrack | null = null;
  readMicroTask: { promise: Promise<void>; cancel: () => void } | null = null;

  constructor(apiKey?: string, inferenceConfig: proto.InferenceConfig = defaultInferenceConfig) {
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
  private participant: RemoteParticipant | string | null = null;
  private localTrack: LocalAudioTrack | null = null;
  private localSource: AudioSource | null = null;

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

      this.localSource = new AudioSource(proto.SAMPLE_RATE, proto.NUM_CHANNELS);
      this.localTrack = LocalAudioTrack.createAudioTrack('agent-mic', this.localSource);
      const options = new TrackPublishOptions();
      options.source = TrackSource.SOURCE_MICROPHONE;
      room.localParticipant?.publishTrack(this.localTrack, options);

      this.ws = new WebSocket(proto.API_URL, {
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
        },
      });

      this.ws.onopen = () => {
        this.connected = true;
        this.sendClientCommand({
          event: proto.ClientEvent.setInferenceConfig,
          ...this.options.inferenceConfig,
        });
      };

      this.ws.onerror = (error) => {
        reject(error);
      };

      this.ws.onclose = () => {
        this.connected = false;
        this.ws = null;
      };

      this.ws.onmessage = (message) => {
        this.handleServerEvent(JSON.parse(message.data as string));
      };
    });
  }

  private sendClientCommand(command: Record<string, unknown>): void {
    if (!this.connected || !this.ws) {
      console.error('WebSocket is not connected');
      return;
    }

    if (command.event !== proto.ClientEvent.addUserAudio) {
      const truncatedDataPartial = command['data']
        ? { data: (command['data'] as string).slice(0, 30) + '…' }
        : {};
      console.log('->', {
        ...command,
        ...truncatedDataPartial,
      });
    }
    this.ws.send(JSON.stringify(command));
  }

  private handleServerEvent(event: Record<string, unknown>): void {
    const truncatedDataPartial = event['data']
      ? { data: (event['data'] as string).slice(0, 30) + '…' }
      : {};
    console.log('<-', {
      ...event,
      ...truncatedDataPartial,
    });

    switch (event.event) {
      case proto.ServerEvent.startSession:
        break;
      case proto.ServerEvent.addItem:
        break;
      case proto.ServerEvent.addContent:
        this.handleAddContent(event);
        break;
      case proto.ServerEvent.itemAdded:
        break;
      case proto.ServerEvent.turnFinished:
        break;
      case proto.ServerEvent.vadSpeechStarted:
        break;
      case proto.ServerEvent.vadSpeechStopped:
        break;
      case proto.ServerEvent.inputTranscribed:
        this.handleInputTranscribed(event);
        break;
      default:
        console.warn('Unknown server event:', event);
    }
  }

  private handleAddContent(event: Record<string, unknown>): void {
    switch (event.type) {
      case 'audio':
        const data = Buffer.from(event.data as string, 'base64');

        const serverFrame = new AudioFrame(
          new Int16Array(data.buffer),
          proto.SAMPLE_RATE,
          proto.NUM_CHANNELS,
          data.length / 2,
        );

        const bstream = new AudioByteStream(
          proto.SAMPLE_RATE,
          proto.NUM_CHANNELS,
          proto.OUTPUT_PCM_FRAME_SIZE,
        );

        for (const frame of bstream.write(serverFrame.data.buffer)) {
          this.localSource?.captureFrame(frame);
        }
        break;
      default:
        break;
    }
  }

  private handleInputTranscribed(event: Record<string, unknown>): void {
    const transcription = event.transcript as string;
    const participantIdentity = this.linkedParticipant?.identity;
    const trackSid = this.subscribedTrack?.sid;
    if (!participantIdentity || !trackSid) {
      console.error('Participant or track not set');
      return;
    }
    this.room?.localParticipant?.publishTranscription({
      participantIdentity,
      trackSid,
      segments: [
        { text: transcription, final: true, id: event.item_id as string, startTime: 0, endTime: 0, language: '' },
      ],
    });
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
      const bstream = new AudioByteStream(
        proto.SAMPLE_RATE,
        proto.NUM_CHANNELS,
        proto.INPUT_PCM_FRAME_SIZE,
      );

      audioStream.on(AudioStreamEvent.FrameReceived, (ev: AudioFrameEvent) => {
        const audioData = ev.frame.data;
        for (const frame of bstream.write(audioData.buffer)) {
          this.sendClientCommand({
            event: proto.ClientEvent.addUserAudio,
            data: Buffer.from(frame.data.buffer).toString('base64'),
          });
        }
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
            readAudioStreamTask(new AudioStream(track, proto.SAMPLE_RATE, proto.NUM_CHANNELS))
              .then(resolve)
              .catch(reject);
          }),
          cancel: () => cancel(),
        };
      }
    }
  }
}
