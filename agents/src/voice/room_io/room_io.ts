// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  ConnectionState,
  type NoiseCancellationOptions,
  type Participant,
  ParticipantKind,
  type RemoteParticipant,
  type Room,
  RoomEvent,
  type TextStreamInfo,
  type TextStreamReader,
  TrackPublishOptions,
  TrackSource,
} from '@livekit/rtc-node';
import type { WritableStreamDefaultWriter } from 'node:stream/web';
import { ATTRIBUTE_PUBLISH_ON_BEHALF, TOPIC_CHAT } from '../../constants.js';
import { log } from '../../log.js';
import { IdentityTransform } from '../../stream/identity_transform.js';
import { Future } from '../../utils.js';
import { type AgentSession } from '../agent_session.js';
import { type AgentStateChangedEvent, type UserInputTranscribedEvent } from '../events.js';
import { AgentSessionEventTypes } from '../events.js';
import type { AudioOutput, TextOutput } from '../io.js';
import { TranscriptionSynchronizer } from '../transcription/synchronizer.js';
import { ParticipantAudioInputStream } from './_input.js';
import {
  ParalellTextOutput,
  ParticipantAudioOutput,
  ParticipantLegacyTranscriptionOutput,
  ParticipantTranscriptionOutput,
} from './_output.js';

export interface TextInputEvent {
  text: string;
  info: TextStreamInfo;
  participant: RemoteParticipant;
}

export type TextInputCallback = (sess: AgentSession, ev: TextInputEvent) => void | Promise<void>;

const DEFAULT_TEXT_INPUT_CALLBACK: TextInputCallback = (sess: AgentSession, ev: TextInputEvent) => {
  sess.interrupt();
  sess.generateReply({ userInput: ev.text });
};

const DEFAULT_PARTICIPANT_KINDS: ParticipantKind[] = [
  ParticipantKind.SIP,
  ParticipantKind.STANDARD,
];

export interface RoomInputOptions {
  audioSampleRate: number;
  audioNumChannels: number;
  textEnabled: boolean;
  audioEnabled: boolean;
  videoEnabled: boolean;
  participantIdentity?: string;
  noiseCancellation?: NoiseCancellationOptions;
  textInputCallback?: TextInputCallback;
  participantKinds?: ParticipantKind[];
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
  textInputCallback: DEFAULT_TEXT_INPUT_CALLBACK,
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
  private participantIdentity: string | null = null;

  private participantAvailableFuture: Future<RemoteParticipant> = new Future();
  private roomConnectedFuture: Future<void> = new Future();

  // Use stream API for transcript queue
  private userTranscriptStream = new IdentityTransform<UserInputTranscribedEvent>();
  private userTranscriptWriter: WritableStreamDefaultWriter<UserInputTranscribedEvent>;
  private forwardUserTranscriptPromise?: Promise<void>;

  // TODO(brian): unregister the text stream handler when the room io is closed
  private textStreamHandlerRegistered = false; // eslint-disable-line @typescript-eslint/no-unused-vars

  private logger = log();

  constructor({
    agentSession,
    room,
    participant = null,
    inputOptions,
    outputOptions,
  }: {
    agentSession: AgentSession;
    room: Room;
    participant?: RemoteParticipant | string | null;
    inputOptions?: Partial<RoomInputOptions>;
    outputOptions?: Partial<RoomOutputOptions>;
  }) {
    this.agentSession = agentSession;
    this.room = room;
    this.inputOptions = { ...DEFAULT_ROOM_INPUT_OPTIONS, ...inputOptions };
    this.outputOptions = { ...DEFAULT_ROOM_OUTPUT_OPTIONS, ...outputOptions };

    this.userTranscriptWriter = this.userTranscriptStream.writable.getWriter();

    this.participantIdentity = participant
      ? typeof participant === 'string'
        ? participant
        : participant.identity
      : this.inputOptions.participantIdentity ?? null;
  }
  private async initTask() {
    await this.roomConnectedFuture.await;

    for (const participant of this.room.remoteParticipants.values()) {
      this.onParticipantConnected(participant);
    }

    const participant = await this.participantAvailableFuture.await;
    this.setParticipant(participant.identity);

    // init agent outputs
    this.updateTranscriptionOutput({
      output: this.agentTranscriptOutput,
      participant: this.room.localParticipant?.identity ?? null,
    });

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

  private onParticipantConnected = (participant: RemoteParticipant) => {
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

    const acceptedKinds = this.inputOptions.participantKinds ?? DEFAULT_PARTICIPANT_KINDS;
    if (participant.info.kind !== undefined && !acceptedKinds.includes(participant.info.kind)) {
      return;
    }

    this.participantAvailableFuture.resolve(participant);
  };

  private onParticipantDisconnected = (participant: RemoteParticipant) => {
    if (participant.identity !== this.participantIdentity) {
      return;
    }

    // TODO(AJS-177): close the session if the participant disconnects unless opted out
    this.unsetParticipant();
  };

  private onUserInputTranscribed = (ev: UserInputTranscribedEvent) => {
    this.userTranscriptWriter.write(ev).catch((error) => {
      this.logger.error({ error }, 'Failed to write transcript event to stream');
    });
  };

  private onAgentStateChanged = async (ev: AgentStateChangedEvent) => {
    if (this.room.isConnected && this.room.localParticipant) {
      await this.room.localParticipant.setAttributes({
        [`lk.agent.state`]: ev.newState,
      });
    }
  };

  private onUserTextInput = (reader: TextStreamReader, participantInfo: { identity: string }) => {
    if (participantInfo.identity !== this.participantIdentity) {
      return;
    }

    const participant = this.room.remoteParticipants.get(participantInfo.identity);
    if (!participant) {
      this.logger.warn('participant not found, ignoring text input');
      return;
    }

    const readText = async () => {
      const text = await reader.readAll();

      const textInputResult = this.inputOptions.textInputCallback!(this.agentSession, {
        text,
        info: reader.info,
        participant,
      });

      // check if callback is a Promise
      if (textInputResult instanceof Promise) {
        await textInputResult;
      }
    };

    readText().catch((error) => {
      this.logger.error({ error }, 'Error reading text input');
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

  private createTranscriptionOutput(options: {
    isDeltaStream: boolean;
    participant: Participant | string | null;
  }) {
    return new ParalellTextOutput([
      new ParticipantLegacyTranscriptionOutput(
        this.room,
        options.isDeltaStream,
        options.participant,
      ),
      new ParticipantTranscriptionOutput(this.room, options.isDeltaStream, options.participant),
    ]);
  }

  private updateTranscriptionOutput({
    output,
    participant,
  }: {
    output?: ParalellTextOutput;
    participant: string | null;
  }) {
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
  setParticipant(participantIdentity: string | null) {
    this.logger.debug({ participantIdentity }, 'setting participant');
    if (participantIdentity === null) {
      this.unsetParticipant();
      return;
    }

    if (this.participantIdentity !== participantIdentity) {
      this.participantAvailableFuture = new Future<RemoteParticipant>();

      // check if new participant is already connected
      for (const participant of this.room.remoteParticipants.values()) {
        if (participant.identity === participantIdentity) {
          this.participantAvailableFuture.resolve(participant);
          break;
        }
      }
    }

    // update participant identity and handlers
    this.participantIdentity = participantIdentity;
    this.audioInput?.setParticipant(participantIdentity);
    this.updateTranscriptionOutput({
      output: this.userTranscriptOutput,
      participant: participantIdentity,
    });
  }

  unsetParticipant() {
    this.participantIdentity = null;
    this.participantAvailableFuture = new Future<RemoteParticipant>();
    this.audioInput?.setParticipant(null);
    this.updateTranscriptionOutput({
      output: this.userTranscriptOutput,
      participant: null,
    });
  }

  start() {
    if (this.inputOptions.textEnabled) {
      try {
        this.room.registerTextStreamHandler(TOPIC_CHAT, this.onUserTextInput);
        this.textStreamHandlerRegistered = true;
      } catch (error) {
        if (this.inputOptions.textEnabled) {
          this.logger.warn(`text stream handler for topic "${TOPIC_CHAT}" already set, ignoring`);
        }
      }
    }

    // -- create inputs --
    if (this.inputOptions.audioEnabled) {
      this.audioInput = new ParticipantAudioInputStream({
        room: this.room,
        sampleRate: this.inputOptions.audioSampleRate,
        numChannels: this.inputOptions.audioNumChannels,
        noiseCancellation: this.inputOptions.noiseCancellation,
      });
    }

    // -- create outputs --
    if (this.outputOptions.audioEnabled) {
      this.participantAudioOutput = new ParticipantAudioOutput(this.room, {
        sampleRate: this.outputOptions.audioSampleRate,
        numChannels: this.outputOptions.audioNumChannels,
        trackPublishOptions: this.outputOptions.audioPublishOptions,
      });
    }
    if (this.outputOptions.transcriptionEnabled) {
      this.userTranscriptOutput = this.createTranscriptionOutput({
        isDeltaStream: false,
        participant: this.participantIdentity,
      });
      // Start the transcript forwarding
      this.forwardUserTranscriptPromise = this.forwardUserTranscript();
      this.agentTranscriptOutput = this.createTranscriptionOutput({
        isDeltaStream: true,
        participant: null,
      });

      // use the RoomIO's audio output if available, otherwise use the agent's audio output
      // TODO(AJS-176): check for agent output
      const audioOutput = this.participantAudioOutput;
      if (this.outputOptions.syncTranscription && audioOutput) {
        this.transcriptionSynchronizer = new TranscriptionSynchronizer(
          audioOutput,
          this.agentTranscriptOutput,
        );
      }
    }

    // -- set the room event handlers --
    this.room.on(RoomEvent.ParticipantConnected, this.onParticipantConnected);
    this.room.on(RoomEvent.ConnectionStateChanged, this.onConnectionStateChanged);
    this.room.on(RoomEvent.ParticipantDisconnected, this.onParticipantDisconnected);
    if (this.room.isConnected) {
      this.onConnectionStateChanged(ConnectionState.CONN_CONNECTED);
    }

    this.initTask().catch((error) => {
      this.logger.error({ error }, 'Failed to initialize RoomIO');
    });

    // -- attatch the agent to the session --
    if (this.audioInput) {
      this.agentSession.input.audio = this.audioInput;
    }
    if (this.audioOutput) {
      this.agentSession.output.audio = this.audioOutput;
    }
    if (this.transcriptionOutput) {
      this.agentSession.output.transcription = this.transcriptionOutput;
    }

    this.agentSession.on(AgentSessionEventTypes.AgentStateChanged, this.onAgentStateChanged);
    this.agentSession.on(AgentSessionEventTypes.UserInputTranscribed, this.onUserInputTranscribed);
  }
}
