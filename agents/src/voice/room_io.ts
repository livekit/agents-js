// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type {
  AudioFrame,
  LocalParticipant,
  Participant,
  RemoteParticipant,
  RemoteTrackPublication,
  Room,
} from '@livekit/rtc-node';
import {
  AudioSource,
  AudioStream,
  LocalAudioTrack,
  type LocalTrackPublication,
  type RemoteTrack,
  RoomEvent,
  TextStreamWriter,
  TrackKind,
  TrackPublishOptions,
  TrackSource,
} from '@livekit/rtc-node';
import { randomUUID } from 'node:crypto';
import type { ReadableStream } from 'node:stream/web';
import {
  ATTRIBUTE_PUBLISH_ON_BEHALF,
  ATTRIBUTE_TRANSCRIPTION_SEGMENT_ID,
  ATTRIBUTE_TRANSCRIPTION_TRACK_ID,
  TOPIC_TRANSCRIPTION,
} from '../constants.js';
import { log } from '../log.js';
import { DeferredReadableStream } from '../stream/deferred_stream.js';
import { Future, Task } from '../utils.js';
import {
  type AgentSession,
  AgentSessionEvent,
  type UserInputTranscribedEvent,
} from './agent_session.js';

function findMicrophoneTrackId(room: Room, identity: string): string {
  let p: Participant | LocalParticipant | null = room.remoteParticipants.get(identity) ?? null;
  if (identity === room.localParticipant?.identity) {
    p = room.localParticipant;
  }

  if (p === null) {
    throw new Error(`Participant ${identity} not found`);
  }

  for (const track of p.trackPublications.values()) {
    if (track.source === TrackSource.SOURCE_MICROPHONE && track.sid) {
      // find the first microphone track
      return track.sid;
    }
  }

  throw new Error(`Participant ${identity} does not have a microphone track`);
}

export abstract class TextOutput {
  abstract captureText(text: string): Promise<void>;
  abstract flush(): void;
}

abstract class ParticipantTextOutput extends TextOutput {
  protected room: Room;

  constructor(room: Room) {
    super();
    this.room = room;
  }

  abstract setParticipant(participant: Participant | string | null): void;

  protected abstract onTrackPublished(
    track: RemoteTrackPublication,
    participant: RemoteParticipant,
  ): void;
  protected abstract onLocalTrackPublished(track: LocalTrackPublication): void;
}

export class ParticipantTranscriptionOutput extends ParticipantTextOutput {
  private isDeltaStream: boolean;

  private capturing: boolean = false;
  private currentId: string = randomUUID();
  private latestText: string = '';
  private logger = log();

  private participantIdentity: string | null = null;
  private trackId: string | null = null;
  private writer: TextStreamWriter | null = null;
  private flushTask: Task<void> | null = null;

  constructor(room: Room, isDeltaStream: boolean, participant: Participant | string | null) {
    super(room);
    this.isDeltaStream = isDeltaStream;

    this.room.on(RoomEvent.TrackPublished, this.onTrackPublished);
    this.room.on(RoomEvent.LocalTrackPublished, this.onLocalTrackPublished);

    this.setParticipant(participant);
  }

  setParticipant(participant: Participant | string | null) {
    if (participant === null) {
      return;
    }

    if (typeof participant === 'string') {
      this.participantIdentity = participant;
    } else {
      this.participantIdentity = participant.identity;
    }

    try {
      this.trackId = findMicrophoneTrackId(this.room, this.participantIdentity);
    } catch (error) {
      // track id is optional for TextStream when audio is not published
      this.trackId = null;
    }

    this.flush();
    this.resetState();
  }

  flush() {
    if (this.participantIdentity === null || !this.capturing) {
      return;
    }

    this.capturing = false;
    const currWriter = this.writer;
    this.writer = null;
    this.flushTask = Task.from((controller) => this.flushTaskImpl(currWriter, controller.signal));
  }

  async captureText(text: string) {
    if (!this.participantIdentity) {
      return;
    }

    if (this.flushTask && !this.flushTask.done) {
      await this.flushTask.result;
    }

    if (!this.capturing) {
      this.resetState();
      this.capturing = true;
    }

    this.latestText = text;
    try {
      if (this.room.isConnected) {
        if (this.isDeltaStream) {
          // reuse the existing writer
          if (this.writer === null) {
            this.writer = await this.createTextWriter();
          }
          await this.writer.write(text);
        } else {
          const tmpWriter = await this.createTextWriter();
          await tmpWriter.write(text);
          await tmpWriter.close();
        }
      }
    } catch (error) {
      this.logger.error(error, 'failed to publish transcription');
    }
  }

  protected onTrackPublished = (track: RemoteTrackPublication, participant: RemoteParticipant) => {
    if (
      this.participantIdentity === null ||
      participant.identity !== this.participantIdentity ||
      track.source !== TrackSource.SOURCE_MICROPHONE
    ) {
      return;
    }

    this.trackId = track.sid ?? null;
  };

  protected onLocalTrackPublished = (track: LocalTrackPublication) => {
    if (
      this.participantIdentity === null ||
      this.participantIdentity !== this.room.localParticipant?.identity ||
      track.source !== TrackSource.SOURCE_MICROPHONE
    ) {
      return;
    }

    this.trackId = track.sid ?? null;
  };

  private async createTextWriter(attributes?: Record<string, string>): Promise<TextStreamWriter> {
    if (!this.participantIdentity) {
      throw new Error('participantIdentity not found');
    }

    if (!this.room.localParticipant) {
      throw new Error('localParticipant not found');
    }

    if (!attributes) {
      attributes = {
        ATTRIBUTE_TRANSCRIPTION_FINAL: 'false',
      };
      if (this.trackId) {
        attributes[ATTRIBUTE_TRANSCRIPTION_TRACK_ID] = this.trackId;
      }
      attributes[ATTRIBUTE_TRANSCRIPTION_SEGMENT_ID] = this.currentId;
    }

    return await this.room.localParticipant.streamText({
      topic: TOPIC_TRANSCRIPTION,
      senderIdentity: this.participantIdentity,
      attributes,
    });
  }

  private async flushTaskImpl(writer: TextStreamWriter | null, signal: AbortSignal): Promise<void> {
    const attributes: Record<string, string> = {
      ATTRIBUTE_TRANSCRIPTION_FINAL: 'true',
    };
    if (this.trackId) {
      attributes[ATTRIBUTE_TRANSCRIPTION_TRACK_ID] = this.trackId;
    }

    const abortPromise = new Promise<void>((resolve) => {
      signal.addEventListener('abort', () => resolve());
    });

    try {
      if (this.room.isConnected) {
        if (this.isDeltaStream) {
          if (writer) {
            await Promise.race([writer.close(), abortPromise]);
          }
        } else {
          const tmpWriter = await Promise.race([this.createTextWriter(attributes), abortPromise]);
          if (signal.aborted || !tmpWriter) {
            return;
          }
          await Promise.race([tmpWriter.write(this.latestText), abortPromise]);
          if (signal.aborted) {
            return;
          }
          await Promise.race([tmpWriter.close(), abortPromise]);
        }
      }
    } catch (error) {
      this.logger.error(error, 'failed to publish transcription');
    }
  }

  private resetState() {
    this.currentId = randomUUID();
    this.capturing = false;
    this.latestText = '';
  }
}

export class ParticipantLegacyTranscriptionOutput extends ParticipantTextOutput {
  private isDeltaStream: boolean;

  private capturing: boolean = false;
  private currentId: string = 'SG_' + randomUUID();
  private latestText: string = '';

  private participantIdentity: string | null = null;
  private trackId: string | null = null;
  private pushedText: string = '';
  private flushTask: Promise<void> | null = null;

  private logger = log();

  constructor(room: Room, isDeltaStream: boolean, participant: Participant | string | null) {
    super(room);
    this.isDeltaStream = isDeltaStream;

    this.room.on(RoomEvent.TrackPublished, this.onTrackPublished);
    this.room.on(RoomEvent.LocalTrackPublished, this.onLocalTrackPublished);

    this.setParticipant(participant);
  }

  setParticipant(participant: Participant | string | null) {
    if (participant === null) {
      return;
    }

    if (typeof participant === 'string') {
      this.participantIdentity = participant;
    } else {
      this.participantIdentity = participant.identity;
    }

    try {
      this.trackId = findMicrophoneTrackId(this.room, this.participantIdentity);
    } catch (error) {
      // track id is optional for TextStream when audio is not published
      this.trackId = null;
    }

    this.flush();
    this.resetState();
  }

  private resetState() {
    this.currentId = 'SG_' + randomUUID();
    this.capturing = false;
    this.latestText = '';
  }

  async captureText(text: string) {
    if (!this.participantIdentity || !this.trackId) {
      return;
    }

    if (this.flushTask) {
      await this.flushTask;
    }

    if (!this.capturing) {
      this.resetState();
      this.capturing = true;
    }

    if (this.isDeltaStream) {
      this.pushedText += text;
    } else {
      this.pushedText = text;
    }

    await this.publishTranscription(this.currentId, this.pushedText, false);
  }

  flush() {
    if (this.participantIdentity === null || !this.capturing || !this.trackId) {
      return;
    }

    this.flushTask = this.publishTranscription(this.currentId, this.pushedText, true);
    this.resetState();
  }

  async publishTranscription(id: string, text: string, final: boolean, signal?: AbortSignal) {
    if (!this.participantIdentity || !this.trackId) {
      return;
    }

    this.logger.debug(
      {
        participantIdentity: this.participantIdentity,
        trackSid: this.trackId,
        segments: [{ id, text, final, startTime: BigInt(0), endTime: BigInt(0), language: '' }],
      },
      'sending text',
    );

    try {
      if (this.room.isConnected) {
        if (signal?.aborted) {
          return;
        }

        await this.room.localParticipant?.publishTranscription({
          participantIdentity: this.participantIdentity,
          trackSid: this.trackId,
          segments: [{ id, text, final, startTime: BigInt(0), endTime: BigInt(0), language: '' }],
        });
      }
    } catch (error) {
      this.logger.error(error, 'failed to publish transcription');
    }
  }

  protected onTrackPublished = (track: RemoteTrackPublication, participant: RemoteParticipant) => {
    if (
      this.participantIdentity === null ||
      participant.identity !== this.participantIdentity ||
      track.source !== TrackSource.SOURCE_MICROPHONE
    ) {
      return;
    }

    this.trackId = track.sid ?? null;
  };

  protected onLocalTrackPublished = (track: LocalTrackPublication) => {
    if (
      this.participantIdentity === null ||
      this.participantIdentity !== this.room.localParticipant?.identity ||
      track.source !== TrackSource.SOURCE_MICROPHONE
    ) {
      return;
    }

    this.trackId = track.sid ?? null;
  };
}

export class ParalellTextOutput extends TextOutput {
  /* @internal */
  _sinks: TextOutput[];

  constructor(sinks: TextOutput[]) {
    super();
    this._sinks = sinks;
  }

  async captureText(text: string) {
    await Promise.all(this._sinks.map((sink) => sink.captureText(text)));
  }

  flush() {
    for (const sink of this._sinks) {
      sink.flush();
    }
  }
}

export interface PlaybackFinishedEvent {
  // How much of the audio was played back
  playbackPosition: number;
  // Interrupted is True if playback was interrupted (clearBuffer() was called)
  interrupted: boolean;
  // Transcript synced with playback; may be partial if the audio was interrupted
  // When null, the transcript is not synchronized with the playback
  synchronizedTranscript?: string;
}

export interface AudioOutputOptions {
  sampleRate: number;
  numChannels: number;
  trackPublishOptions: TrackPublishOptions;
  queueSizeMs?: number;
}
export class ParticipantAudioOutput {
  private room: Room;
  private options: AudioOutputOptions;
  private audioSource: AudioSource;
  private publication?: LocalTrackPublication;
  private flushTask?: Task<void>;
  private pushedDurationMs: number = 0;
  private startedFuture: Future<void> = new Future();
  private interruptedFuture: Future<void> = new Future();

  private playbackFinishedFuture: Future<void> = new Future();
  private capturing: boolean = false;
  private playbackFinishedCount: number = 0;
  private playbackSegmentsCount: number = 0;
  private lastPlaybackEvent: PlaybackFinishedEvent = {
    playbackPosition: 0,
    interrupted: false,
  };

  private logger = log();

  constructor(room: Room, options: AudioOutputOptions) {
    this.room = room;
    this.options = options;
    this.audioSource = new AudioSource(options.sampleRate, options.numChannels);
  }

  get queueSizeMs(): number {
    return this.options.queueSizeMs ?? 100000;
  }

  async start(): Promise<void> {
    this.startedFuture = new Future();
    this.publishTrack();
    this.startedFuture.resolve();
  }

  /**
   * Capture an audio frame for playback, frames can be pushed faster than real-time
   */
  async captureFrame(frame: AudioFrame): Promise<void> {
    await this.startedFuture.await;

    if (!this.capturing) {
      this.capturing = true;
      this.playbackSegmentsCount++;
    }

    // TODO(shubhra): use frame.durationMs once available in rtc-node
    this.pushedDurationMs += frame.samplesPerChannel / frame.sampleRate;
    await this.audioSource.captureFrame(frame);
  }

  /**
   * Wait for the past audio segments to finish playing out.
   *
   * @returns The event that was emitted when the audio finished playing out (only the last segment information)
   */
  async waitForPlayout(): Promise<PlaybackFinishedEvent> {
    const target = this.playbackSegmentsCount;

    while (this.playbackFinishedCount < target) {
      await this.playbackFinishedFuture.await;
      this.playbackFinishedFuture = new Future();
    }

    return this.lastPlaybackEvent;
  }

  private async waitForPlayoutTask(abortController: AbortController): Promise<void> {
    const abortFuture = new Future<boolean>();

    const resolveAbort = () => {
      if (!abortFuture.done) abortFuture.resolve(true);
    };

    abortController.signal.addEventListener('abort', resolveAbort);

    this.audioSource.waitForPlayout().finally(() => {
      abortController.signal.removeEventListener('abort', resolveAbort);
      if (!abortFuture.done) abortFuture.resolve(false);
    });

    const interrupted = await abortFuture.await;

    let pushedDuration = this.pushedDurationMs;

    if (interrupted) {
      // Calculate actual played duration accounting for queued audio
      pushedDuration = Math.max(this.pushedDurationMs - this.audioSource.queuedDuration, 0);
      this.audioSource.clearQueue();
    }

    this.pushedDurationMs = 0;
    this.onPlaybackFinished({
      playbackPosition: pushedDuration,
      interrupted,
      // TODO: implement transcript synchronization
    });
  }

  /**
   * Flush any buffered audio, marking the current playback/segment as complete
   */
  flush(): void {
    this.capturing = false;

    if (!this.pushedDurationMs) {
      return;
    }

    if (this.flushTask && !this.flushTask.done) {
      this.logger.error('flush called while playback is in progress');
      this.flushTask.cancel();
    }

    this.flushTask = Task.from((controller) => this.waitForPlayoutTask(controller));
  }

  /**
   * Clear the buffer, stopping playback immediately
   */
  clearBuffer(): void {
    if (!this.pushedDurationMs) {
      return;
    }

    this.interruptedFuture.resolve();
  }

  private onPlaybackFinished(event: PlaybackFinishedEvent) {
    this.lastPlaybackEvent = event;
    this.playbackFinishedCount++;
    this.playbackFinishedFuture.resolve();
  }

  private async publishTrack() {
    const track = LocalAudioTrack.createAudioTrack('roomio_audio', this.audioSource);
    this.publication = await this.room.localParticipant?.publishTrack(
      track,
      new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }),
    );
    await this.publication?.waitForSubscription();
  }
}

export class RoomIO {
  private agentSession: AgentSession;
  private participantAudioInputStream: ReadableStream<AudioFrame>;

  private room: Room;

  private _deferredAudioInputStream = new DeferredReadableStream<AudioFrame>();
  private participantAudioOutput?: ParticipantAudioOutput;
  private userTranscriptOutput: ParalellTextOutput | null = null;
  private agentTranscriptOutput: ParalellTextOutput | null = null;

  private participantIdentity: string | null = null;
  private participantAvailableFuture: Future<Participant> = new Future();
  private roomConnectedFuture: Future<void> = new Future();

  private logger = log();

  constructor(
    agentSession: AgentSession,
    room: Room,
    private readonly sampleRate: number,
    private readonly numChannels: number,
  ) {
    this.agentSession = agentSession;
    this.room = room;
    this.participantAudioInputStream = this._deferredAudioInputStream.stream;
  }

  private onTrackSubscribed = (track: RemoteTrack) => {
    if (track.kind === TrackKind.KIND_AUDIO) {
      this._deferredAudioInputStream.setSource(
        new AudioStream(track, {
          // TODO(AJS-41) remove hardcoded sample rate
          sampleRate: 16000,
          numChannels: 1,
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

  private onParticipantConnected(participant: Participant) {
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

    // TODO(shubhra): allow user to specify accepted participany kinds

    this.participantAvailableFuture.resolve(participant);
  }

  private onUserInputTranscribed = (ev: UserInputTranscribedEvent) => {
    this.logger.debug({ ev }, 'user input transcribed');
    this.userTranscriptOutput?.captureText(ev.transcript);
    if (ev.isFinal) {
      this.userTranscriptOutput?.flush();
    }
  };

  private createTranscriptionOutput(options: {
    isDeltaStream: boolean;
    participant: string | null;
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

  private updateTranscriptionOutput(output: ParalellTextOutput | null, participant?: string) {
    if (output === null) {
      return;
    }

    for (const sink of output._sinks) {
      if (
        sink instanceof ParticipantLegacyTranscriptionOutput ||
        sink instanceof ParticipantTranscriptionOutput
      ) {
        sink.setParticipant(participant ?? null);
      }
    }
  }

  start() {
    // -- create outputs --
    this.participantAudioOutput = new ParticipantAudioOutput(this.room, {
      sampleRate: this.sampleRate,
      numChannels: this.numChannels,
      trackPublishOptions: new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }),
    });

    this.userTranscriptOutput = this.createTranscriptionOutput({
      isDeltaStream: false,
      participant: this.participantIdentity,
    });
    this.agentTranscriptOutput = this.createTranscriptionOutput({
      isDeltaStream: true,
      participant: null,
    });

    // -- set the room event handlers --
    this.room.on(RoomEvent.ParticipantConnected, this.onParticipantConnected);
    this.room.on(RoomEvent.TrackSubscribed, this.onTrackSubscribed);
    if (this.room.isConnected) {
      this.roomConnectedFuture.resolve();
    }

    this.initTask();

    // -- attatch the agent to the session --
    this.agentSession.audioInput = this.participantAudioInputStream;
    this.agentSession.audioOutput = this.participantAudioOutput;
    this.agentSession._transcriptionOutput = this.agentTranscriptOutput;

    this.agentSession.on(AgentSessionEvent.UserInputTranscribed, this.onUserInputTranscribed);
  }
}
