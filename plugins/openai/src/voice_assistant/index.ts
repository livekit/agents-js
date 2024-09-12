// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
// import { log } from '@livekit/agents';
import { AudioByteStream } from '@livekit/agents';
import { findMicroTrackId } from '@livekit/agents';
import { log } from '@livekit/agents';
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
  voice: proto.Voice.ALLOY,
  max_tokens: 2048,
  temperature: 0.8,
  disable_audio: false,
  turn_end_type: proto.TurnEndType.SERVER_DETECTION,
  transcribe_input: true,
  audio_format: proto.AudioFormat.PCM16,
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
  private localTrackSid: string | null = null;
  private localSource: AudioSource | null = null;
  private pendingMessages: Map<string, string> = new Map();

  start(room: Room, participant: RemoteParticipant | string | null = null): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.ws !== null) {
        log().warn('VoiceAssistant already started');
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
      this.localTrack = LocalAudioTrack.createAudioTrack('assistant_voice', this.localSource);
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
          event: proto.ClientEvent.SET_INFERENCE_CONFIG,
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
      log().error('WebSocket is not connected');
      return;
    }

    if (command.event !== proto.ClientEvent.ADD_USER_AUDIO) {
      const truncatedDataPartial = command['data']
        ? { data: (command['data'] as string).slice(0, 30) + '…' }
        : {};
      log().debug('->', {
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
    log().debug('<-', {
      ...event,
      ...truncatedDataPartial,
    });

    switch (event.event) {
      case proto.ServerEvent.START_SESSION:
        break;
      case proto.ServerEvent.ADD_ITEM:
        this.handleAddItem(event);
        break;
      case proto.ServerEvent.ADD_CONTENT:
        this.handleAddContent(event);
        break;
      case proto.ServerEvent.ITEM_ADDED:
        this.handleItemAdded(event);
        break;
      case proto.ServerEvent.TURN_FINISHED:
        break;
      case proto.ServerEvent.VAD_SPEECH_STARTED:
        this.handleVadSpeechStarted(event);
        break;
      case proto.ServerEvent.VAD_SPEECH_STOPPED:
        break;
      case proto.ServerEvent.INPUT_TRANSCRIBED:
        this.handleInputTranscribed(event);
        break;
      default:
        log().warn('Unknown server event:', event);
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
      case 'text':
        const itemId = event.item_id as string;
        if (itemId && this.pendingMessages.has(itemId)) {
          const existingText = this.pendingMessages.get(itemId) || '';
          const newText = existingText + (event.data as string);
          this.pendingMessages.set(itemId, newText);

          const participantIdentity = this.room?.localParticipant?.identity;
          const trackSid = this.getLocalTrackSid();
          if (participantIdentity && trackSid) {
            this.publishTranscription(participantIdentity, trackSid, newText, false, itemId);
          } else {
            log().error('Participant or track not set');
          }
        }
        break;
      default:
        break;
    }
  }

  private handleAddItem(event: Record<string, unknown>): void {
    const itemId = event.id as string;
    if (itemId && event.type === 'message') {
      this.pendingMessages.set(itemId, '');
    }
  }

  private handleItemAdded(event: Record<string, unknown>): void {
    const itemId = event.id as string;
    if (itemId && this.pendingMessages.has(itemId)) {
      const text = this.pendingMessages.get(itemId) || '';
      this.pendingMessages.delete(itemId);

      const participantIdentity = this.room?.localParticipant?.identity;
      const trackSid = this.getLocalTrackSid();
      if (participantIdentity && trackSid) {
        this.publishTranscription(participantIdentity, trackSid, text, true, itemId);
      } else {
        log().error('Participant or track not set');
      }
    }
  }

  private handleInputTranscribed(event: Record<string, unknown>): void {
    const itemId = event.item_id as string;
    const transcription = event.transcript as string;
    if (!itemId || !transcription) {
      log().error('Item ID or transcription not set');
      return;
    }
    const participantIdentity = this.linkedParticipant?.identity;
    const trackSid = this.subscribedTrack?.sid;
    if (participantIdentity && trackSid) {
      this.publishTranscription(participantIdentity, trackSid, transcription, true, itemId);
    } else {
      log().error('Participant or track not set');
    }
  }

  private handleVadSpeechStarted(event: Record<string, unknown>): void {
    const itemId = event.item_id as string;
    const participantIdentity = this.linkedParticipant?.identity;
    const trackSid = this.subscribedTrack?.sid;
    if (participantIdentity && trackSid && itemId) {
      this.publishTranscription(participantIdentity, trackSid, '', false, itemId);
    } else {
      log().error('Participant or track or itemId not set');
    }
  }

  private linkParticipant(participantIdentity: string): void {
    if (!this.room) {
      log().error('Room is not set');
      return;
    }

    this.linkedParticipant = this.room.remoteParticipants.get(participantIdentity) || null;
    if (!this.linkedParticipant) {
      log().error(`Participant with identity ${participantIdentity} not found`);
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
            event: proto.ClientEvent.ADD_USER_AUDIO,
            data: Buffer.from(frame.data.buffer).toString('base64'),
          });
        }
      });
    };

    if (!this.linkedParticipant) {
      log().error('Participant is not set');
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

  private getLocalTrackSid(): string | null {
    if (!this.localTrackSid && this.room && this.room.localParticipant) {
      this.localTrackSid = findMicroTrackId(this.room, this.room.localParticipant?.identity);
    }
    return this.localTrackSid;
  }

  private publishTranscription(
    participantIdentity: string,
    trackSid: string,
    text: string,
    isFinal: boolean,
    id: string,
  ): void {
    if (!this.room?.localParticipant) {
      log().error('Room or local participant not set');
      return;
    }

    this.room.localParticipant.publishTranscription({
      participantIdentity,
      trackSid,
      segments: [
        {
          text,
          final: isFinal,
          id,
          startTime: BigInt(0),
          endTime: BigInt(0),
          language: '',
        },
      ],
    });
  }
}
