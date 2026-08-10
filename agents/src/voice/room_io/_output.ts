// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AgentSession as pb } from '@livekit/protocol';
import type { RemoteParticipant } from '@livekit/rtc-node';
import {
  type AudioFrame,
  AudioSource,
  LocalAudioTrack,
  type LocalTrackPublication,
  type Participant,
  type RemoteTrackPublication,
  type Room,
  RoomEvent,
  type TextStreamWriter,
  TrackPublishOptions,
  TrackSource,
} from '@livekit/rtc-node';
import {
  ATTRIBUTE_TRANSCRIPTION_FINAL,
  ATTRIBUTE_TRANSCRIPTION_SEGMENT_ID,
  ATTRIBUTE_TRANSCRIPTION_TRACK_ID,
  TOPIC_TRANSCRIPTION,
} from '../../constants.js';
import { log } from '../../log.js';
import { Future, Task, shortuuid } from '../../utils.js';
import { AudioOutput, TextOutput, type TimedString, isTimedString } from '../io.js';
import { findMicrophoneTrackId } from '../transcription/index.js';

abstract class BaseParticipantTranscriptionOutput extends TextOutput {
  protected room: Room;
  protected isDeltaStream: boolean;
  protected participantIdentity: string | null = null;
  protected trackId?: string;
  protected capturing: boolean = false;
  protected latestText: string = '';
  protected currentId: string = this.generateCurrentId();
  protected logger = log();

  constructor(room: Room, isDeltaStream: boolean, participant: Participant | string | null) {
    super();
    this.room = room;
    this.isDeltaStream = isDeltaStream;

    this.room.on(RoomEvent.TrackPublished, this.onTrackPublished);
    this.room.on(RoomEvent.LocalTrackPublished, this.onLocalTrackPublished);

    this.setParticipant(participant);
  }

  setParticipant(participant: Participant | string | null) {
    if (typeof participant === 'string' || participant === null) {
      this.participantIdentity = participant;
    } else {
      this.participantIdentity = participant.identity;
    }

    if (!this.participantIdentity) {
      return;
    }

    try {
      this.trackId = findMicrophoneTrackId(this.room, this.participantIdentity);
    } catch (error) {
      // track id is optional for TextStream when audio is not published
    }

    this.flush();
    this.resetState();
  }

  protected onTrackPublished = (track: RemoteTrackPublication, participant: RemoteParticipant) => {
    if (
      !this.participantIdentity ||
      participant.identity !== this.participantIdentity ||
      track.source !== TrackSource.SOURCE_MICROPHONE
    ) {
      return;
    }

    this.trackId = track.sid;
  };

  protected onLocalTrackPublished = (track: LocalTrackPublication | undefined) => {
    if (!track) {
      this.logger.warn('LocalTrackPublished event without publication payload');
      return;
    }

    if (
      !this.participantIdentity ||
      this.participantIdentity !== this.room.localParticipant?.identity ||
      track.source !== TrackSource.SOURCE_MICROPHONE
    ) {
      return;
    }

    this.trackId = track.sid;
  };

  protected generateCurrentId(): string {
    return shortuuid('SG_');
  }

  protected resetState() {
    this.currentId = this.generateCurrentId();
    this.capturing = false;
    this.latestText = '';
  }

  async captureText(text: string | TimedString) {
    if (!this.participantIdentity) {
      return;
    }

    const textStr = isTimedString(text) ? text.text : text;
    this.latestText = textStr;
    await this.handleCaptureText(textStr);
  }

  flush() {
    if (!this.participantIdentity || !this.capturing) {
      return;
    }

    this.capturing = false;
    this.handleFlush();
  }

  protected abstract handleCaptureText(text: string): Promise<void>;
  protected abstract handleFlush(): void;
}

export interface ParticipantTranscriptionOutputOptions {
  /** When true, each chunk sent on the `lk.transcription` datastream topic is serialized
   *  as a JSON object with `text`, and `start_time`/`end_time`/`confidence`/
   *  `start_time_offset` when the captured value is a TimedString. Each object is
   *  suffixed with a newline so subscribers can parse the stream line-by-line. */
  jsonFormat?: boolean;
}

export class ParticipantTranscriptionOutput extends BaseParticipantTranscriptionOutput {
  private writer: TextStreamWriter | null = null;
  private flushTask: Task<void> | null = null;
  private jsonFormat: boolean;

  constructor(
    room: Room,
    isDeltaStream: boolean,
    participant: Participant | string | null,
    options: ParticipantTranscriptionOutputOptions = {},
  ) {
    super(room, isDeltaStream, participant);
    this.jsonFormat = options.jsonFormat ?? false;
  }

  override async captureText(text: string | TimedString) {
    if (!this.participantIdentity) {
      return;
    }

    // latestText must hold the encoded payload so non-delta flush (FINAL=true) republishes the
    // same newline-delimited JSON format as the interim chunks.
    const payload = this.jsonFormat
      ? this.encodeJsonChunk(text)
      : isTimedString(text)
        ? text.text
        : text;
    this.latestText = payload;
    await this.handleCaptureText(payload);
  }

  private encodeJsonChunk(text: string | TimedString): string {
    const isTimed = isTimedString(text);
    const message = new pb.TimedString({
      text: isTimed ? text.text : text,
      startTime: isTimed ? text.startTime : undefined,
      endTime: isTimed ? text.endTime : undefined,
      confidence: isTimed ? text.confidence : undefined,
      startTimeOffset: isTimed ? text.startTimeOffset : undefined,
    });
    return message.toJsonString({ useProtoFieldName: true }) + '\n';
  }

  protected async handleCaptureText(text: string): Promise<void> {
    if (this.flushTask && !this.flushTask.done) {
      await this.flushTask.result;
    }

    if (!this.capturing) {
      this.resetState();
      this.capturing = true;
    }

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

  protected handleFlush() {
    const currWriter = this.writer;
    this.writer = null;
    this.flushTask = Task.from((controller) => this.flushTaskImpl(currWriter, controller.signal));
  }

  private async createTextWriter(attributes?: Record<string, string>): Promise<TextStreamWriter> {
    if (!this.participantIdentity) {
      throw new Error('participantIdentity not found');
    }

    if (!this.room.localParticipant) {
      throw new Error('localParticipant not found');
    }

    if (!attributes) {
      attributes = {
        [ATTRIBUTE_TRANSCRIPTION_FINAL]: 'false',
      };
      if (this.trackId) {
        attributes[ATTRIBUTE_TRANSCRIPTION_TRACK_ID] = this.trackId;
      }
    }
    attributes[ATTRIBUTE_TRANSCRIPTION_SEGMENT_ID] = this.currentId;

    return await this.room.localParticipant.streamText({
      topic: TOPIC_TRANSCRIPTION,
      senderIdentity: this.participantIdentity,
      attributes,
    });
  }

  private async flushTaskImpl(writer: TextStreamWriter | null, signal: AbortSignal): Promise<void> {
    const attributes: Record<string, string> = {
      [ATTRIBUTE_TRANSCRIPTION_FINAL]: 'true',
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
}

export class ParticipantLegacyTranscriptionOutput extends BaseParticipantTranscriptionOutput {
  private pushedText: string = '';
  private flushTask: Promise<void> | null = null;

  protected async handleCaptureText(text: string): Promise<void> {
    if (!this.trackId) {
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

  protected handleFlush() {
    if (!this.trackId) {
      return;
    }

    this.flushTask = this.publishTranscription(this.currentId, this.pushedText, true);
    this.resetState();
  }

  async publishTranscription(id: string, text: string, final: boolean, signal?: AbortSignal) {
    if (!this.participantIdentity || !this.trackId) {
      return;
    }

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

  protected resetState() {
    super.resetState();
    this.pushedText = '';
  }
}

export class ParalellTextOutput extends TextOutput {
  /** @internal */
  _sinks: TextOutput[];

  constructor(sinks: TextOutput[], nextInChain?: TextOutput) {
    super(nextInChain);
    this._sinks = sinks;
  }

  async captureText(text: string | TimedString) {
    await Promise.all(this._sinks.map((sink) => sink.captureText(text)));
  }

  flush() {
    for (const sink of this._sinks) {
      sink.flush();
    }
  }
}

export interface AudioOutputOptions {
  sampleRate: number;
  numChannels: number;
  trackPublishOptions: TrackPublishOptions;
  queueSizeMs?: number;
}
export class ParticipantAudioOutput extends AudioOutput {
  private room: Room;
  private options: AudioOutputOptions;
  private audioSource: AudioSource;
  private publication?: LocalTrackPublication;
  private flushTask?: Task<void>;
  private flushPushedDuration?: number;

  /** Duration of audio pushed to the source, in seconds */
  private pushedDuration: number = 0;
  private sourcePushedDuration: number = 0;
  private sourceDiscardedDuration: number = 0;
  private captureSequence: number = 0;
  private captureSegment: number = 0;
  private playbackStartedSegment?: number;
  private captureDurations: Map<
    number,
    { pushedDuration: number; sourcePushedDuration: number; sourceDiscardedDuration: number }
  > = new Map();
  private interruptionGeneration: number = 0;
  private interruptionSnapshot?: {
    future: Future<void>;
    sourcePushedDuration: number;
    sourceDiscardedDuration: number;
    queuedDuration: number;
    pendingSegments: number;
    captureCutoff: number;
  };
  private forwardingCount: number = 0;
  /** Resolved only while no capture is held or being submitted to AudioSource. */
  private forwardingIdleFuture: Future<void> = new Future();
  private startedFuture: Future<void> = new Future();
  private interruptedFuture: Future<void> = new Future();
  // playbackStarted fires once per segment; a mid-segment pause/resume does not re-arm this.
  private firstFrameEmitted: boolean = false;
  /** Gate held closed while the output is paused; frame forwarding awaits it. */
  private playbackEnabledFuture: Future<void> = new Future();

  constructor(room: Room, options: AudioOutputOptions) {
    super(options.sampleRate, undefined, { pause: true });
    this.room = room;
    this.options = options;
    this.audioSource = new AudioSource(
      options.sampleRate,
      options.numChannels,
      options.queueSizeMs,
    );
    this.playbackEnabledFuture.resolve();
    this.forwardingIdleFuture.resolve();
  }

  pause(): void {
    if (this.playbackEnabledFuture.done) {
      this.playbackEnabledFuture = new Future();
    }
    super.pause();
  }

  resume(): void {
    if (!this.playbackEnabledFuture.done) {
      this.playbackEnabledFuture.resolve();
    }
    super.resume();
  }

  get subscribed(): boolean {
    return this.startedFuture.done;
  }

  async start(signal: AbortSignal): Promise<void> {
    await this.publishTrack(signal);
  }

  async captureFrame(frame: AudioFrame): Promise<void> {
    if (!this.startedFuture.done) {
      await this.startedFuture.await;
    }

    const segmentCapture = super.captureFrame(frame);
    const frameDuration = frame.samplesPerChannel / frame.sampleRate;
    this.captureSegment ??= 0;
    const captureSegment = this.captureSegment;
    this.captureSequence = (this.captureSequence ?? 0) + 1;
    const captureSequence = this.captureSequence;
    this.captureDurations ??= new Map();
    const captureDuration = {
      pushedDuration: frameDuration,
      sourcePushedDuration: 0,
      sourceDiscardedDuration: 0,
    };
    this.captureDurations.set(captureSequence, captureDuration);
    this.pushedDuration += frameDuration;
    this.interruptionGeneration ??= 0;
    const interruptionGeneration = this.interruptionGeneration;
    const interruptionFuture = this.interruptedFuture;
    this.forwardingCount = (this.forwardingCount ?? 0) + 1;
    if (
      this.forwardingCount === 1 &&
      (!this.forwardingIdleFuture || this.forwardingIdleFuture.done)
    ) {
      this.forwardingIdleFuture = new Future();
    }

    try {
      await segmentCapture;
      if (interruptionGeneration !== this.interruptionGeneration || interruptionFuture.done) {
        return;
      }
      if (!this.playbackEnabledFuture.done) {
        const queuedDuration = this.audioSource.queuedDuration ?? 0;
        let remainingDiscardedDuration = queuedDuration / 1000;
        for (const duration of [...this.captureDurations.values()].reverse()) {
          const availableDuration = Math.max(
            duration.sourcePushedDuration - duration.sourceDiscardedDuration,
            0,
          );
          const discardedDuration = Math.min(availableDuration, remainingDiscardedDuration);
          duration.sourceDiscardedDuration += discardedDuration;
          remainingDiscardedDuration -= discardedDuration;
          if (remainingDiscardedDuration <= 0) {
            break;
          }
        }
        this.sourceDiscardedDuration = (this.sourceDiscardedDuration ?? 0) + queuedDuration / 1000;
        this.audioSource.clearQueue();
        await Promise.race([this.playbackEnabledFuture.await, interruptionFuture.await]);
        if (interruptionGeneration !== this.interruptionGeneration || interruptionFuture.done) {
          return;
        }
      }

      if (this.playbackStartedSegment !== captureSegment) {
        this.playbackStartedSegment = captureSegment;
        this.firstFrameEmitted = true;
        this.onPlaybackStarted(Date.now());
      }

      captureDuration.sourcePushedDuration += frameDuration;
      this.sourcePushedDuration = (this.sourcePushedDuration ?? 0) + frameDuration;
      await this.audioSource.captureFrame(frame);
    } finally {
      this.forwardingCount--;
      if (this.forwardingCount === 0) {
        this.forwardingIdleFuture?.resolve();
      }
    }
  }

  private async waitForPlayoutTask(abortController: AbortController): Promise<void> {
    const accountedDuration = this.pushedDuration;
    const captureCutoff = this.captureSequence ?? 0;
    const interruptionFuture = this.interruptedFuture;
    const abortFuture = new Future<boolean>();

    const resolveAbort = () => {
      if (!abortFuture.done) abortFuture.resolve(true);
    };

    abortController.signal.addEventListener('abort', resolveAbort);

    const waitForForwardingAndPlayout = async () => {
      await this.forwardingIdleFuture?.await;
      await this.audioSource.waitForPlayout();
    };

    waitForForwardingAndPlayout().finally(() => {
      abortController.signal.removeEventListener('abort', resolveAbort);
      if (!abortFuture.done) abortFuture.resolve(false);
    });

    const aborted = await Promise.race([
      abortFuture.await,
      interruptionFuture.await.then(() => true),
    ]);
    const interrupted = interruptionFuture.done || aborted;
    const interruptionSnapshot =
      interrupted && this.interruptionSnapshot?.future === interruptionFuture
        ? this.interruptionSnapshot
        : undefined;
    const captureDurations = [...(this.captureDurations?.entries() ?? [])]
      .filter(([sequence]) => sequence <= captureCutoff)
      .map(([, duration]) => duration);
    const capturedSourcePushedDuration = captureDurations.reduce(
      (total, duration) => total + duration.sourcePushedDuration,
      0,
    );
    const capturedSourceDiscardedDuration = captureDurations.reduce(
      (total, duration) => total + duration.sourceDiscardedDuration,
      0,
    );

    let pushedDuration = Math.max(
      (interruptionSnapshot?.sourcePushedDuration ??
        (captureDurations.length > 0 ? capturedSourcePushedDuration : this.sourcePushedDuration) ??
        accountedDuration) -
        (interruptionSnapshot?.sourceDiscardedDuration ??
          (captureDurations.length > 0
            ? capturedSourceDiscardedDuration
            : this.sourceDiscardedDuration) ??
          0),
      0,
    );

    if (interrupted) {
      pushedDuration = Math.max(
        pushedDuration -
          (interruptionSnapshot?.queuedDuration ?? this.audioSource.queuedDuration ?? 0) / 1000,
        0,
      );
      if (!interruptionSnapshot) {
        this.audioSource.clearQueue();
      }
    }

    const finishedCaptureCutoff = interruptionSnapshot?.captureCutoff ?? captureCutoff;
    for (const sequence of this.captureDurations?.keys() ?? []) {
      if (sequence <= finishedCaptureCutoff) {
        this.captureDurations.delete(sequence);
      }
    }
    if (!interruptionSnapshot) {
      const remainingDurations = [...(this.captureDurations?.values() ?? [])];
      this.pushedDuration = remainingDurations.reduce(
        (total, duration) => total + duration.pushedDuration,
        0,
      );
      this.sourcePushedDuration = remainingDurations.reduce(
        (total, duration) => total + duration.sourcePushedDuration,
        0,
      );
      this.sourceDiscardedDuration = remainingDurations.reduce(
        (total, duration) => total + duration.sourceDiscardedDuration,
        0,
      );
      if (remainingDurations.length === 0) {
        this.firstFrameEmitted = false;
      }
    }
    if (this.interruptedFuture === interruptionFuture) {
      this.interruptedFuture = new Future();
    }

    const pendingSegments = interruptionSnapshot?.pendingSegments ?? this.pendingPlayoutSegments;
    const finishes =
      interrupted && Number.isFinite(pendingSegments) ? Math.max(pendingSegments, 1) : 1;
    for (let i = 0; i < finishes; i++) {
      this.onPlaybackFinished({
        playbackPosition: i === 0 ? pushedDuration : 0,
        interrupted,
      });
    }
    if (this.interruptionSnapshot === interruptionSnapshot) {
      this.interruptionSnapshot = undefined;
    }
  }

  /**
   * Flush any buffered audio, marking the current playback/segment as complete
   */
  flush(): void {
    super.flush();

    if (!this.pushedDuration && this.pendingPlayoutSegments === 0) {
      return;
    }

    if (this.flushTask && !this.flushTask.done) {
      if (this.flushPushedDuration === this.pushedDuration) {
        return;
      }

      this.logger.error('flush called while playback is in progress');
      this.flushTask.cancel();
    }

    this.captureSegment = (this.captureSegment ?? 0) + 1;
    this.flushPushedDuration = this.pushedDuration;
    const flushTask = Task.from((controller) => this.waitForPlayoutTask(controller));
    this.flushTask = flushTask;
    void flushTask.result
      .finally(() => {
        if (this.flushTask === flushTask) {
          this.flushPushedDuration = undefined;
        }
      })
      .catch(() => {});
  }

  clearBuffer(): void {
    this.interruptionGeneration = (this.interruptionGeneration ?? 0) + 1;
    if (!this.playbackEnabledFuture.done) {
      this.playbackEnabledFuture.resolve();
      this.playbackEnabledFuture = new Future();
    }
    if (
      this.interruptedFuture.done ||
      (this.pushedDuration === 0 && this.pendingPlayoutSegments === 0)
    ) {
      return;
    }
    if (
      (this.pushedDuration > 0 || this.pendingPlayoutSegments > 0) &&
      (!this.flushTask || this.flushTask.done)
    ) {
      this.flush();
    }
    if (this.pendingPlayoutSegments > 0) {
      const captureCutoff = this.captureSequence ?? 0;
      const captureDurations = [...(this.captureDurations?.entries() ?? [])]
        .filter(([sequence]) => sequence <= captureCutoff)
        .map(([, duration]) => duration);
      this.interruptionSnapshot = {
        future: this.interruptedFuture,
        sourcePushedDuration:
          captureDurations.length > 0
            ? captureDurations.reduce((total, duration) => total + duration.sourcePushedDuration, 0)
            : this.sourcePushedDuration,
        sourceDiscardedDuration:
          captureDurations.length > 0
            ? captureDurations.reduce(
                (total, duration) => total + duration.sourceDiscardedDuration,
                0,
              )
            : this.sourceDiscardedDuration,
        queuedDuration: this.audioSource.queuedDuration ?? 0,
        pendingSegments: this.pendingPlayoutSegments,
        captureCutoff,
      };
      this.pushedDuration = 0;
      this.sourcePushedDuration = 0;
      this.sourceDiscardedDuration = 0;
      this.firstFrameEmitted = false;
      this.audioSource.clearQueue();
    }
    if (!this.interruptedFuture.done) {
      this.interruptedFuture.resolve();
    }
  }

  private async publishTrack(signal: AbortSignal) {
    const track = LocalAudioTrack.createAudioTrack('roomio_audio', this.audioSource);
    this.publication = await this.room.localParticipant?.publishTrack(
      track,
      this.options.trackPublishOptions ??
        new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }),
    );

    if (signal.aborted) {
      return;
    }

    await this.publication?.waitForSubscription();

    if (!this.startedFuture.done) {
      this.startedFuture.resolve();
    }
  }

  async close() {
    await this.audioSource.close();
  }
}
