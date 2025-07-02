// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { ConnectionState, type Participant, type Room } from '@livekit/rtc-node';
import { RoomEvent, TrackPublishOptions, TrackSource } from '@livekit/rtc-node';
import type { WritableStreamDefaultWriter } from 'node:stream/web';
import { ATTRIBUTE_PUBLISH_ON_BEHALF } from '../../constants.js';
import { log } from '../../log.js';
import { IdentityTransform } from '../../stream/identity_transform.js';
import { Future } from '../../utils.js';
import {
  type AgentSession,
  AgentSessionEvent,
  type UserInputTranscribedEvent,
} from '../agent_session.js';
import type { AudioOutput, TextOutput } from '../io.js';
import { TranscriptionSynchronizer } from '../transcription/synchronizer.js';
import { ParticipantAudioInputStream } from './_input.js';
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
  private room: Room;
  private inputOptions: RoomInputOptions;
  private outputOptions: RoomOutputOptions;

  private audioInput?: ParticipantAudioInputStream;
  private participantAudioOutput?: ParticipantAudioOutput;
  private userTranscriptOutput?: ParalellTextOutput;
  private agentTranscriptOutput?: ParalellTextOutput;
  private transcriptionSynchronizer?: TranscriptionSynchronizer;
  private participantIdentity?: string;

  private participantAvailableFuture: Future<Participant> = new Future();
  private roomConnectedFuture: Future<void> = new Future();

  // Use stream API for transcript queue
  private userTranscriptStream = new IdentityTransform<UserInputTranscribedEvent>();
  private userTranscriptWriter: WritableStreamDefaultWriter<UserInputTranscribedEvent>;
  private forwardUserTranscriptPromise?: Promise<void>;

  private logger = log();

  constructor({
    agentSession,
    room,
    _participant, // TODO (AJS-106): Add multi participant support
    inputOptions,
    outputOptions,
  }: {
    agentSession: AgentSession;
    room: Room;
    _participant?: Participant;
    inputOptions?: Partial<RoomInputOptions>;
    outputOptions?: Partial<RoomOutputOptions>;
  }) {
    this.agentSession = agentSession;
    this.room = room;
    this.inputOptions = { ...DEFAULT_ROOM_INPUT_OPTIONS, ...inputOptions };
    this.outputOptions = { ...DEFAULT_ROOM_OUTPUT_OPTIONS, ...outputOptions };

    this.userTranscriptWriter = this.userTranscriptStream.writable.getWriter();
  }

  private async initTask() {
    await this.roomConnectedFuture.await;

    for (const participant of this.room.remoteParticipants.values()) {
      this.onParticipantConnected(participant);
    }

    const participant = await this.participantAvailableFuture.await;
    this.setParticipant(participant.identity);

    // init user outputs
    this.updateTranscriptionOutput(this.userTranscriptOutput, participant.identity);

    // init agent outputs
    this.updateTranscriptionOutput(
      this.agentTranscriptOutput,
      this.room.localParticipant?.identity,
    );

    await this.participantAudioOutput?.start();
  }

  private onConnectionStateChanged = (state: ConnectionState) => {
    this.logger.debug({ state }, 'connection state changed');
    if (
      state === ConnectionState.CONN_CONNECTED &&
      this.room.isConnected &&
      !this.roomConnectedFuture.done
    ) {
      this.roomConnectedFuture.resolve();
    }
  };

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
    this.userTranscriptWriter.write(ev).catch((error) => {
      this.logger.error({ error }, 'Failed to write transcript event to stream');
    });
  };

  private async forwardUserTranscript(): Promise<void> {
    const reader = this.userTranscriptStream.readable.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const event = value;
        // IMPORTANT: need to await here to avoid race condition
        await this.userTranscriptOutput?.captureText(event.transcript);
        if (event.isFinal) {
          this.userTranscriptOutput?.flush();
        }
      }
    } catch (error) {
      this.logger.error({ error }, 'Error processing transcript stream');
    }
  }

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

  /* Switch to a different participant */
  setParticipant(participant: string) {
    if (this.participantIdentity) {
      throw new Error('Changing participant is not supported yet');
    }

    this.participantIdentity = participant;
    this.audioInput?.setParticipant(participant);
  }

  start() {
    // -- create inputs --
    this.audioInput = new ParticipantAudioInputStream({
      room: this.room,
      sampleRate: this.inputOptions.audioSampleRate,
      numChannels: this.inputOptions.audioNumChannels,
    });

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

    // Start the transcript forwarding
    this.forwardUserTranscriptPromise = this.forwardUserTranscript();

    // -- set the room event handlers --
    this.room.on(RoomEvent.ParticipantConnected, this.onParticipantConnected);
    this.room.on(RoomEvent.ConnectionStateChanged, this.onConnectionStateChanged);

    if (this.room.isConnected) {
      this.onConnectionStateChanged(ConnectionState.CONN_CONNECTED);
    }

    this.initTask().catch((error) => {
      this.logger.error({ error }, 'Failed to initialize RoomIO');
    });

    // -- attatch the agent to the session --
    this.agentSession.audioInput = this.audioInput.audioStream;
    this.agentSession.audioOutput = this.audioOutput;
    this.agentSession._transcriptionOutput = this.transcriptionOutput;

    this.agentSession.on(AgentSessionEvent.UserInputTranscribed, this.onUserInputTranscribed);
  }
}
