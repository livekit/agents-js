// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type AudioFrame,
  ConnectionState,
  DisconnectReason,
  type FrameProcessor,
  type NoiseCancellationOptions,
  ParticipantKind,
  type RemoteParticipant,
  type RemoteTrackPublication,
  type Room,
  RoomEvent,
  TrackKind,
  TrackPublishOptions,
  TrackSource,
} from '@livekit/rtc-node';
import { ATTRIBUTE_PUBLISH_ON_BEHALF } from '../../constants.js';
import { log } from '../../log.js';
import { Future, Task } from '../../utils.js';
import { CloseReason, type UserInputTranscribedEvent } from '../../voice/events.js';
import type { AudioInput, AudioOutput, TextOutput } from '../../voice/io.js';
import { ParticipantAudioInputStream } from '../../voice/room_io/_input.js';
import {
  ParalellTextOutput,
  ParticipantAudioOutput,
  ParticipantLegacyTranscriptionOutput,
  ParticipantTranscriptionOutput,
} from '../../voice/room_io/_output.js';
import { DEFAULT_PARTICIPANT_KINDS } from '../../voice/room_io/room_io.js';
import {
  TranscriptionSynchronizer,
  defaultTextSyncOptions,
} from '../../voice/transcription/synchronizer.js';
import type { TranslationSession } from './translation_session.js';

const CLOSE_ON_DISCONNECT_REASONS = [
  DisconnectReason.CLIENT_INITIATED,
  DisconnectReason.ROOM_DELETED,
  DisconnectReason.USER_REJECTED,
];

/** Audio-input configuration for `TranslationRoomIO`. */
export interface TranslationAudioInputOptions {
  /** Sample rate delivered to the model. Defaults to 24000 Hz. */
  sampleRate?: number;
  /** Channel count delivered to the model. Defaults to one. */
  numChannels?: number;
  /** Audio frame duration in milliseconds. Defaults to 50. */
  frameSizeMs?: number;
  /** RTC noise cancellation or frame processor applied to source audio. */
  noiseCancellation?: NoiseCancellationOptions | FrameProcessor<AudioFrame>;
}

/** Audio-output configuration for `TranslationRoomIO`. */
export interface TranslationAudioOutputOptions {
  /** Published sample rate. Defaults to 24000 Hz. */
  sampleRate?: number;
  /** Published channel count. Defaults to one. */
  numChannels?: number;
  /** RTC publication options for the translated track. */
  trackPublishOptions?: TrackPublishOptions;
  /** Published track name. Defaults to `roomio_audio`. */
  trackName?: string;
  /** RTC audio-source queue size in milliseconds. Defaults to 200. */
  queueSizeMs?: number;
}

/** Transcript-output configuration for `TranslationRoomIO`. */
export interface TranslationTextOutputOptions {
  /** Synchronize translated text with audio playback. Defaults to `true`. */
  syncTranscription?: boolean;
  /** Speaking-rate multiplier used by transcript synchronization. */
  transcriptionSpeedFactor?: number;
  /** Serialize stream chunks as newline-delimited timed-string JSON. */
  jsonFormat?: boolean;
  /** Additional caller-owned text sink that receives every translated transcript. */
  nextInChain?: TextOutput;
}

/**
 * Controls how a `TranslationSession` hears one room track and publishes its translation.
 */
export interface TranslationRoomOptions {
  /** Source speech. Pass `false` to feed session audio directly. */
  audioInput?: TranslationAudioInputOptions | boolean;
  /** Published translated-audio track. Pass `false` to consume audio directly. */
  audioOutput?: TranslationAudioOutputOptions | boolean;
  /** Input and translated transcripts. Pass `false` to consume transcripts directly. */
  textOutput?: TranslationTextOutputOptions | boolean;
  /** Exact audio publication SID to translate, including screenshare audio. */
  track?: string;
  /** Participant used to narrow automatic microphone selection. Ignored with `track`. */
  participantIdentity?: string;
  /** Participant kinds accepted by automatic selection. */
  participantKinds?: ParticipantKind[];
  /** Close when the linked publisher voluntarily disconnects. Defaults to `true`. */
  closeOnDisconnect?: boolean;
}

/** A linked source publication and the participant that published it. */
export interface LinkedTranslationTrack {
  /** Exact audio publication being translated. */
  publication: RemoteTrackPublication;
  /** Participant that published the track. */
  participant: RemoteParticipant;
}

/**
 * Wires a `TranslationSession` to one room audio track.
 *
 * Selection is track-based rather than participant-based so published transcripts can carry the
 * exact source publication SID and participants with multiple audio tracks are unambiguous.
 */
export class TranslationRoomIO {
  private options: TranslationRoomOptions;
  private trackSid: string | null;
  private participantIdentity: string | null;
  private _audioInput: ParticipantAudioInputStream | null = null;
  private participantAudioOutput: ParticipantAudioOutput | null = null;
  private inputTranscriptOutput: ParalellTextOutput | null = null;
  private outputTranscriptOutput: ParalellTextOutput | null = null;
  private synchronizer: TranscriptionSynchronizer | null = null;
  private trackAvailable = new Future<LinkedTranslationTrack>();
  private roomConnected = new Future<void>();
  private ready = new Future<void>();
  private initTask: Task<void> | null = null;
  private closeTask: Promise<void> | null = null;
  private transcriptTail: Promise<void> = Promise.resolve();
  private logger = log();

  constructor(
    private session: TranslationSession,
    /** LiveKit room used for source and translated tracks. */
    readonly room: Room,
    options: TranslationRoomOptions = {},
  ) {
    this.options = options;
    this.trackSid = options.track ?? null;
    this.participantIdentity = options.participantIdentity ?? null;
  }

  /** Attach room-backed devices and begin waiting for the selected source track. */
  async start(): Promise<void> {
    const audioInput = this.resolveOption(this.options.audioInput);
    if (audioInput) {
      this._audioInput = new ParticipantAudioInputStream({
        room: this.room,
        sampleRate: audioInput.sampleRate ?? 24000,
        numChannels: audioInput.numChannels ?? 1,
        frameSizeMs: audioInput.frameSizeMs ?? 50,
        noiseCancellation: audioInput.noiseCancellation,
        trackSource: [TrackSource.SOURCE_MICROPHONE, TrackSource.SOURCE_SCREENSHARE_AUDIO],
      });
    }

    const audioOutput = this.resolveOption(this.options.audioOutput);
    if (audioOutput) {
      this.participantAudioOutput = new ParticipantAudioOutput(this.room, {
        sampleRate: audioOutput.sampleRate ?? 24000,
        numChannels: audioOutput.numChannels ?? 1,
        trackPublishOptions:
          audioOutput.trackPublishOptions ??
          new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }),
        queueSizeMs: audioOutput.queueSizeMs ?? 200,
        trackName: audioOutput.trackName,
      });
    }

    const textOutput = this.resolveOption(this.options.textOutput);
    if (textOutput) {
      this.outputTranscriptOutput = this.createTranscriptionOutput({
        isDeltaStream: true,
        participant: null,
        jsonFormat: textOutput.jsonFormat ?? false,
        nextInChain: textOutput.nextInChain,
      });
      const audio = this.participantAudioOutput ?? this.session.output.audio;
      if (textOutput.syncTranscription !== false && audio) {
        this.synchronizer = new TranscriptionSynchronizer(audio, this.outputTranscriptOutput, {
          ...defaultTextSyncOptions,
          speed: textOutput.transcriptionSpeedFactor ?? 1,
        });
      }
    }

    this.room.on(RoomEvent.TrackPublished, this.onTrackPublished);
    this.room.on(RoomEvent.ParticipantConnected, this.onParticipantConnected);
    this.room.on(RoomEvent.ParticipantDisconnected, this.onParticipantDisconnected);
    this.room.on(RoomEvent.ConnectionStateChanged, this.onConnectionStateChanged);
    if (this.room.isConnected) this.onConnectionStateChanged(ConnectionState.CONN_CONNECTED);
    this.initTask = Task.from((controller) => this.init(controller.signal));

    if (this.audioInput) this.session.input.audio = this.audioInput;
    if (this.audioOutput) this.session.output.audio = this.audioOutput;
    if (this.transcriptionOutput) this.session.output.transcription = this.transcriptionOutput;
    this.session.on('user_input_transcribed', this.onInputTranscribed);
  }

  /** Stop room wiring and release only devices created by this object. */
  async close(): Promise<void> {
    if (!this.closeTask) this.closeTask = this.closeImpl();
    await this.closeTask;
  }

  /** @internal Abort startup and release output waits before session forwarding is joined. */
  _abort(): void {
    this.initTask?.cancel();
    void this.participantAudioOutput?.close();
  }

  private async closeImpl(): Promise<void> {
    this._abort();
    this.room.off(RoomEvent.TrackPublished, this.onTrackPublished);
    this.room.off(RoomEvent.ParticipantConnected, this.onParticipantConnected);
    this.room.off(RoomEvent.ParticipantDisconnected, this.onParticipantDisconnected);
    this.room.off(RoomEvent.ConnectionStateChanged, this.onConnectionStateChanged);
    this.session.off('user_input_transcribed', this.onInputTranscribed);
    await this.initTask?.cancelAndWait();
    await this.transcriptTail.catch(() => {});
    await this._audioInput?.close();
    await this.synchronizer?.close();
    await Promise.all([this.inputTranscriptOutput?.close(), this.outputTranscriptOutput?.close()]);
    await this.participantAudioOutput?.close();
  }

  /** Room-created source audio input, or `null` when disabled. */
  get audioInput(): AudioInput | null {
    return this._audioInput;
  }

  /** Room-created translated-audio output, including transcript synchronization. */
  get audioOutput(): AudioOutput | null {
    return this.synchronizer?.audioOutput ?? this.participantAudioOutput;
  }

  /** Room-created translated-text output, including transcript synchronization. */
  get transcriptionOutput(): TextOutput | null {
    return this.synchronizer?.textOutput ?? this.outputTranscriptOutput;
  }

  /** Currently linked publication and its publisher, or `null` while waiting. */
  get linkedTrack(): LinkedTranslationTrack | null {
    return this.trackAvailable.done ? this.trackAvailable.result : null;
  }

  /** Participant publishing `linkedTrack`, or `null` while waiting. */
  get linkedParticipant(): RemoteParticipant | null {
    return this.linkedTrack?.participant ?? null;
  }

  /** Whether the translated audio track has a subscriber. */
  get subscribed(): boolean | null {
    return this.participantAudioOutput?.subscribed ?? null;
  }

  /** Wait until the source is linked and translated output has been published. */
  async waitForReady(): Promise<void> {
    await this.ready.await;
  }

  /**
   * Translate an exact publication, now or when it is published later.
   *
   * Passing `null` unsets the source. A known non-audio publication is rejected.
   */
  setTrack(trackSid: string | null): void {
    if (trackSid === null) {
      this.unsetTrack();
      return;
    }
    const linked = this.linkedTrack;
    if (linked?.publication.sid === trackSid) {
      this.trackSid = trackSid;
      this._audioInput?.setTrackSid(trackSid);
      return;
    }

    let found: LinkedTranslationTrack | null = null;
    for (const participant of this.room.remoteParticipants.values()) {
      const publication = participant.trackPublications.get(trackSid);
      if (!publication) continue;
      if (publication.kind !== TrackKind.KIND_AUDIO) {
        throw new Error(`track ${trackSid} is not audio`);
      }
      found = { publication, participant };
      break;
    }

    if (this.trackAvailable.done) this.trackAvailable = new Future();
    this.trackSid = trackSid;
    if (found) {
      this.trackAvailable.resolve(found);
      this.applyLink(found);
    } else {
      this._audioInput?.setTrackSid(trackSid);
    }
  }

  /** Stop translating any room track. */
  unsetTrack(): void {
    this.trackSid = null;
    this.participantIdentity = null;
    this.trackAvailable = new Future();
    this._audioInput?.setTrackSid(null);
    this._audioInput?.setParticipant(null);
    this.setTranscriptLink(null, null);
  }

  /** @internal Apply a linked source to audio and transcript sinks. */
  _applyLink(linked: LinkedTranslationTrack): void {
    this.applyLink(linked);
  }

  /** @internal Process a publication event. */
  _onTrackPublished(publication: RemoteTrackPublication, participant: RemoteParticipant): void {
    this.onTrackPublished(publication, participant);
  }

  private resolveOption<T>(option: T | boolean | undefined): T | null {
    if (option === false) return null;
    return (option === true || option === undefined ? {} : option) as T;
  }

  private createTranscriptionOutput(options: {
    isDeltaStream: boolean;
    participant: string | null;
    track?: string;
    jsonFormat?: boolean;
    nextInChain?: TextOutput;
  }): ParalellTextOutput {
    const sinkOptions = { trackSid: options.track, expressiveEnabled: () => false };
    return new ParalellTextOutput(
      [
        new ParticipantLegacyTranscriptionOutput(
          this.room,
          options.isDeltaStream,
          options.participant,
          sinkOptions,
        ),
        new ParticipantTranscriptionOutput(this.room, options.isDeltaStream, options.participant, {
          ...sinkOptions,
          jsonFormat: options.jsonFormat,
        }),
      ],
      options.nextInChain,
    );
  }

  private setTranscriptLink(participant: string | null, track: string | null): void {
    for (const sink of this.inputTranscriptOutput?._sinks ?? []) {
      if (
        sink instanceof ParticipantLegacyTranscriptionOutput ||
        sink instanceof ParticipantTranscriptionOutput
      ) {
        sink.setLink(participant, track);
      }
    }
  }

  private applyLink(linked: LinkedTranslationTrack): void {
    this.participantIdentity = linked.participant.identity;
    const trackSid = linked.publication.sid;
    if (!trackSid) throw new Error('linked translation track has no SID');
    this._audioInput?.setTrackSid(trackSid);
    this._audioInput?.setParticipant(this.participantIdentity);
    this.setTranscriptLink(this.participantIdentity, trackSid);
    this.logger.info(
      { trackSid, participantIdentity: this.participantIdentity, roomName: this.room.name },
      'TranslationRoomIO linked to track',
    );
  }

  private async init(signal: AbortSignal): Promise<void> {
    await Promise.race([this.roomConnected.await, this.waitForAbort(signal)]);
    if (signal.aborted) return;
    for (const participant of this.room.remoteParticipants.values()) {
      this.onParticipantConnected(participant);
    }
    const linked = await Promise.race([this.trackAvailable.await, this.waitForAbort(signal)]);
    if (!linked || signal.aborted) return;

    if (this.resolveOption(this.options.textOutput)) {
      this.inputTranscriptOutput = this.createTranscriptionOutput({
        isDeltaStream: false,
        participant: linked.participant.identity,
        track: linked.publication.sid,
      });
    }
    this.applyLink(linked);
    if (this.outputTranscriptOutput) {
      for (const sink of this.outputTranscriptOutput._sinks) {
        if (
          sink instanceof ParticipantLegacyTranscriptionOutput ||
          sink instanceof ParticipantTranscriptionOutput
        ) {
          sink.setParticipant(this.room.localParticipant?.identity ?? null);
        }
      }
    }
    await this.participantAudioOutput?.start(signal);
    if (!this.ready.done) this.ready.resolve();
  }

  private waitForAbort(signal: AbortSignal): Promise<undefined> {
    if (signal.aborted) return Promise.resolve(undefined);
    return new Promise((resolve) =>
      signal.addEventListener('abort', () => resolve(undefined), { once: true }),
    );
  }

  private onInputTranscribed = (event: UserInputTranscribedEvent): void => {
    this.transcriptTail = this.transcriptTail
      .then(async () => {
        await this.inputTranscriptOutput?.captureText(event.transcript);
        if (event.isFinal) this.inputTranscriptOutput?.flush();
      })
      .catch((error) => {
        this.logger.error({ error }, 'failed to forward translation input transcript');
      });
  };

  private onConnectionStateChanged = (_state: ConnectionState): void => {
    if (this.room.isConnected && !this.roomConnected.done) this.roomConnected.resolve();
  };

  private onParticipantConnected = (participant: RemoteParticipant): void => {
    for (const publication of participant.trackPublications.values()) {
      this.onTrackPublished(publication, participant);
    }
  };

  private onTrackPublished = (
    publication: RemoteTrackPublication,
    participant: RemoteParticipant,
  ): void => {
    if (this.trackAvailable.done || publication.kind !== TrackKind.KIND_AUDIO) return;
    if (this.trackSid !== null) {
      if (publication.sid !== this.trackSid) return;
    } else {
      if (publication.source !== TrackSource.SOURCE_MICROPHONE) return;
      if (this.participantIdentity !== null) {
        if (participant.identity !== this.participantIdentity) return;
      } else if (
        participant.attributes[ATTRIBUTE_PUBLISH_ON_BEHALF] === this.room.localParticipant?.identity
      ) {
        return;
      }
      const acceptedKinds = this.options.participantKinds ?? DEFAULT_PARTICIPANT_KINDS;
      if (
        !acceptedKinds.includes(
          participant.kind ?? participant.info.kind ?? ParticipantKind.STANDARD,
        )
      ) {
        return;
      }
    }

    const linked = { publication, participant };
    this.trackAvailable.resolve(linked);
    if (this.initTask?.done) this.applyLink(linked);
  };

  private onParticipantDisconnected = (participant: RemoteParticipant): void => {
    if (participant.identity !== this.linkedParticipant?.identity) return;
    this.trackAvailable = new Future();
    if (
      this.options.closeOnDisconnect !== false &&
      participant.disconnectReason !== undefined &&
      CLOSE_ON_DISCONNECT_REASONS.includes(participant.disconnectReason)
    ) {
      this.logger.info(
        { roomName: this.room.name, participantIdentity: participant.identity },
        'closing translation session due to participant disconnect',
      );
      this.session._closeSoon(CloseReason.PARTICIPANT_DISCONNECTED);
    }
  };
}
