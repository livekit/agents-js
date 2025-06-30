// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type AudioFrame,
  AudioStream,
  type Participant,
  type RemoteTrack,
  type Room,
  RoomEvent,
  TrackKind,
  TrackPublishOptions,
  TrackSource,
} from '@livekit/rtc-node';
import type { ReadableStream } from 'node:stream/web';
import { ATTRIBUTE_PUBLISH_ON_BEHALF } from '../../constants.js';
import { log } from '../../log.js';
import { DeferredReadableStream } from '../../stream/deferred_stream.js';
import { Future } from '../../utils.js';
import {
  type AgentSession,
  AgentSessionEvent,
  type UserInputTranscribedEvent,
} from '../agent_session.js';
import type { AudioOutput, TextOutput } from '../io.js';
import { TranscriptionSynchronizer } from '../transcription/synchronizer.js';
import {
  ParalellTextOutput,
  ParticipantAudioOutput,
  ParticipantLegacyTranscriptionOutput,
  ParticipantTranscriptionOutput,
} from './_output.js';

export interface RoomInputOptions {
  audioSampleRate: number;
  audioNumChannels: number;
  textEnabled: boolean;
  audioEnabled: boolean;
  videoEnabled: boolean;
  participantIdentity?: string;
}

export interface RoomOutputOptions {
  transcriptionEnabled: boolean;
  audioEnabled: boolean;
  audioSampleRate: number;
  audioNumChannels: number;
  syncTranscription: boolean;
  audioPublishOptions: TrackPublishOptions;
}

const DEFAULT_ROOM_INPUT_OPTIONS: RoomInputOptions = {
  audioSampleRate: 24000,
  audioNumChannels: 1,
  textEnabled: true,
  audioEnabled: true,
  videoEnabled: false,
};

const DEFAULT_ROOM_OUTPUT_OPTIONS: RoomOutputOptions = {
  audioSampleRate: 24000,
  audioNumChannels: 1,
  transcriptionEnabled: true,
  audioEnabled: true,
  syncTranscription: true,
  audioPublishOptions: new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }),
};

export class RoomIO {
  private agentSession: AgentSession;
  private participantAudioInputStream: ReadableStream<AudioFrame>;
  private room: Room;
  private inputOptions: RoomInputOptions;
  private outputOptions: RoomOutputOptions;

  private _deferredAudioInputStream = new DeferredReadableStream<AudioFrame>();
  private participantAudioOutput?: ParticipantAudioOutput;
  private userTranscriptOutput?: ParalellTextOutput;
  private agentTranscriptOutput?: ParalellTextOutput;
  private transcriptionSynchronizer?: TranscriptionSynchronizer;
  private participantIdentity?: string;

  private participantAvailableFuture: Future<Participant> = new Future();
  private roomConnectedFuture: Future<void> = new Future();

  private logger = log();

  constructor({
    agentSession,
    room,
    participant,
    inputOptions,
    outputOptions,
  }: {
    agentSession: AgentSession;
    room: Room;
    participant?: Participant;
    inputOptions?: Partial<RoomInputOptions>;
    outputOptions?: Partial<RoomOutputOptions>;
  }) {
    this.agentSession = agentSession;
    this.room = room;
    this.inputOptions = { ...DEFAULT_ROOM_INPUT_OPTIONS, ...inputOptions };
    this.outputOptions = { ...DEFAULT_ROOM_OUTPUT_OPTIONS, ...outputOptions };
    this.participantAudioInputStream = this._deferredAudioInputStream.stream;
    this.participantIdentity = participant?.identity ?? this.inputOptions.participantIdentity;
    if (!this.participantIdentity && this.inputOptions.participantIdentity !== undefined) {
      this.participantIdentity = this.inputOptions.participantIdentity;
    }
  }

  private onTrackSubscribed = (track: RemoteTrack) => {
    if (track.kind === TrackKind.KIND_AUDIO) {
      this._deferredAudioInputStream.setSource(
        new AudioStream(track, {
          sampleRate: this.inputOptions.audioSampleRate,
          numChannels: this.inputOptions.audioNumChannels,
        }),
      );
    }
  };

  private async initTask() {
    await this.roomConnectedFuture.await;

    for (const participant of this.room.remoteParticipants.values()) {
      this.onParticipantConnected(participant);
    }

    const participant = await this.participantAvailableFuture.await;

    // init user outputs
    this.updateTranscriptionOutput(this.userTranscriptOutput, participant.identity);

    // init agent outputs
    this.updateTranscriptionOutput(
      this.agentTranscriptOutput,
      this.room.localParticipant?.identity,
    );

    await this.participantAudioOutput?.start();
  }

  private onParticipantConnected = (participant: Participant) => {
    this.logger.debug({ participant }, 'participant connected');
    if (this.participantAvailableFuture.done) {
      return;
    }

    if (this.participantIdentity) {
      if (participant.identity !== this.participantIdentity) {
        return;
      }
    } else if (
      // otherwise, skip participants that are marked as publishing for this agent
      participant.attributes?.[ATTRIBUTE_PUBLISH_ON_BEHALF] === this.room.localParticipant?.identity
    ) {
      return;
    }

    // TODO(AJS-105): allow user to specify accepted participany kinds

    this.participantAvailableFuture.resolve(participant);
  };

  private onUserInputTranscribed = (ev: UserInputTranscribedEvent) => {
    this.logger.debug({ ev }, 'user input transcribed');
    this.userTranscriptOutput?.captureText(ev.transcript);
    if (ev.isFinal) {
      this.userTranscriptOutput?.flush();
    }
  };

  private createTranscriptionOutput(options: { isDeltaStream: boolean; participant?: string }) {
    return new ParalellTextOutput([
      new ParticipantLegacyTranscriptionOutput(
        this.room,
        options.isDeltaStream,
        options.participant,
      ),
      new ParticipantTranscriptionOutput(this.room, options.isDeltaStream, options.participant),
    ]);
  }

  private updateTranscriptionOutput(output?: ParalellTextOutput, participant?: string) {
    if (!output) {
      return;
    }

    for (const sink of output._sinks) {
      if (
        sink instanceof ParticipantLegacyTranscriptionOutput ||
        sink instanceof ParticipantTranscriptionOutput
      ) {
        sink.setParticipant(participant);
      }
    }
  }

  get audioOutput(): AudioOutput | undefined {
    if (!this.transcriptionSynchronizer) {
      return this.participantAudioOutput;
    }

    return this.transcriptionSynchronizer.audioOutput;
  }

  get transcriptionOutput(): TextOutput | undefined {
    if (!this.transcriptionSynchronizer) {
      return this.agentTranscriptOutput;
    }

    return this.transcriptionSynchronizer.textOutput;
  }

  start() {
    // -- create outputs --
    this.participantAudioOutput = new ParticipantAudioOutput(this.room, {
      sampleRate: this.outputOptions.audioSampleRate,
      numChannels: this.outputOptions.audioNumChannels,
      trackPublishOptions: this.outputOptions.audioPublishOptions,
    });

    this.userTranscriptOutput = this.createTranscriptionOutput({
      isDeltaStream: false,
      participant: this.participantIdentity,
    });
    this.agentTranscriptOutput = this.createTranscriptionOutput({
      isDeltaStream: true,
    });

    this.transcriptionSynchronizer = new TranscriptionSynchronizer(
      this.participantAudioOutput,
      this.agentTranscriptOutput,
    );

    // -- set the room event handlers --
    this.room.on(RoomEvent.ParticipantConnected, this.onParticipantConnected);
    this.room.on(RoomEvent.TrackSubscribed, this.onTrackSubscribed);
    if (this.room.isConnected) {
      this.roomConnectedFuture.resolve();
    }

    this.initTask();

    // -- attatch the agent to the session --
    this.agentSession.audioInput = this.participantAudioInputStream;
    this.agentSession.audioOutput = this.audioOutput;
    this.agentSession._transcriptionOutput = this.transcriptionOutput;

    this.agentSession.on(AgentSessionEvent.UserInputTranscribed, this.onUserInputTranscribed);
  }
}
