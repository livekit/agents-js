// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
// import { log } from '@livekit/agents';
import { AudioByteStream } from '@livekit/agents';
import { findMicroTrackId } from '@livekit/agents';
import { log } from '@livekit/agents';
import type {
  AudioFrameEvent,
  LocalTrackPublication,
  RemoteAudioTrack,
  RemoteParticipant,
  Room,
} from '@livekit/rtc-node';
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
import { AgentPlayout, PlayoutHandle } from './agent_playout.js';
import * as proto from './proto.js';
import { BasicTranscriptionForwarder } from './transcription_forwarder.js';

export const defaultInferenceConfig: proto.InferenceConfig = {
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

  constructor(
    inferenceConfig: proto.InferenceConfig = defaultInferenceConfig,
    apiKey: string = process.env.OPENAI_API_KEY || '',
  ) {
    if (!apiKey) {
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
  private agentPublication: LocalTrackPublication | null = null;
  private localTrackSid: string | null = null;
  private localSource: AudioSource | null = null;
  private agentPlayout: AgentPlayout | null = null;
  private playingHandle: PlayoutHandle | null = null;

  start(room: Room, participant: RemoteParticipant | string | null = null): Promise<void> {
    return new Promise(async (resolve, reject) => {
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
      room.on(RoomEvent.TrackPublished, () => {
        this.subscribeToMicrophone();
      });
      room.on(RoomEvent.TrackSubscribed, () => {
        this.subscribeToMicrophone();
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
      this.agentPlayout = new AgentPlayout(this.localSource);
      const track = LocalAudioTrack.createAudioTrack('assistant_voice', this.localSource);
      const options = new TrackPublishOptions();
      options.source = TrackSource.SOURCE_MICROPHONE;
      this.agentPublication = (await room.localParticipant?.publishTrack(track, options)) || null;
      if (!this.agentPublication) {
        log().error('Failed to publish track');
        reject(new Error('Failed to publish track'));
        return;
      }

      await this.agentPublication.waitForSubscription();

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
        resolve();
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

  addUserMessage(text: string): void {
    this.sendClientCommand({
      event: proto.ClientEvent.ADD_ITEM,
      type: 'message',
      role: 'user',
      content: [
        {
          type: 'text',
          text: text,
        },
      ],
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
      log().debug(`-> ${JSON.stringify({ ...command, ...truncatedDataPartial })}`);
    }
    this.ws.send(JSON.stringify(command));
  }

  private handleServerEvent(event: Record<string, unknown>): void {
    const truncatedDataPartial = event['data']
      ? { data: (event['data'] as string).slice(0, 30) + '…' }
      : {};
    log().debug(`<- ${JSON.stringify({ ...event, ...truncatedDataPartial })}`);

    switch (event.event) {
      case proto.ServerEvent.START_SESSION:
        break;
      case proto.ServerEvent.ADD_ITEM:
        break;
      case proto.ServerEvent.ADD_CONTENT:
        this.handleAddContent(event);
        break;
      case proto.ServerEvent.ITEM_ADDED:
        break;
      case proto.ServerEvent.TURN_FINISHED:
        this.handleTurnFinished(event);
        break;
      case proto.ServerEvent.VAD_SPEECH_STARTED:
        this.handleVadSpeechStarted(event);
        break;
      case proto.ServerEvent.VAD_SPEECH_STOPPED:
        break;
      case proto.ServerEvent.INPUT_TRANSCRIBED:
        this.handleInputTranscribed(event);
        break;
      case proto.ServerEvent.MODEL_LISTENING:
        break;
      default:
        log().warn(`Unknown server event: ${JSON.stringify(event)}`);
    }
  }

  private handleAddContent(event: Record<string, unknown>): void {
    const trackSid = this.getLocalTrackSid();
    if (!this.room || !this.room.localParticipant || !trackSid || !this.agentPlayout) {
      log().error('Room or local participant not set');
      return;
    }

    if (this.playingHandle === null || this.playingHandle.done) {
      const trFwd = new BasicTranscriptionForwarder(
        this.room as Room,
        this.room?.localParticipant?.identity,
        trackSid,
        event.item_id as string,
      );

      this.playingHandle = this.agentPlayout.play(event.item_id as string, trFwd);
    }
    switch (event.type) {
      case 'audio':
        this.playingHandle?.pushAudio(Buffer.from(event.data as string, 'base64'));
        break;
      case 'text':
        this.playingHandle?.pushText(event.data as string);
        break;
      default:
        log().warn(`Unknown content event type: ${event.type}`);
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

  private handleTurnFinished(event: Record<string, unknown>): void {
    if (event.reason !== 'interrupt' && event.reason !== 'stop') {
      log().warn(`assistant turn finished unexpectedly reason ${event.reason}`);
    }

    if (this.playingHandle !== null && !this.playingHandle.interrupted) {
      this.playingHandle.endInput();
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
