// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
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
import { AudioOutput, TextOutput } from '../io.js';
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

  protected onLocalTrackPublished = (track: LocalTrackPublication) => {
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

  async captureText(text: string) {
    if (!this.participantIdentity) {
      return;
    }

    this.latestText = text;
    await this.handleCaptureText(text);
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

export class ParticipantTranscriptionOutput extends BaseParticipantTranscriptionOutput {
  private writer: TextStreamWriter | null = null;
  private flushTask: Task<void> | null = null;

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

  async captureText(text: string) {
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
  private pushedDurationMs: number = 0;
  private startedFuture: Future<void> = new Future();
  private interruptedFuture: Future<void> = new Future();

  constructor(room: Room, options: AudioOutputOptions) {
    super(options.sampleRate);
    this.room = room;
    this.options = options;
    this.audioSource = new AudioSource(options.sampleRate, options.numChannels);
  }

  get subscribed(): boolean {
    return this.startedFuture.done;
  }

  async start(signal: AbortSignal): Promise<void> {
    await this.publishTrack(signal);
  }

  async captureFrame(frame: AudioFrame): Promise<void> {
    await this.startedFuture.await;

    super.captureFrame(frame);

    // TODO(AJS-102): use frame.durationMs once available in rtc-node
    this.pushedDurationMs += frame.samplesPerChannel / frame.sampleRate;
    await this.audioSource.captureFrame(frame);
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

    const interrupted = await Promise.race([
      abortFuture.await,
      this.interruptedFuture.await.then(() => true),
    ]);

    let pushedDuration = this.pushedDurationMs;

    if (interrupted) {
      // Calculate actual played duration accounting for queued audio
      pushedDuration = Math.max(this.pushedDurationMs - this.audioSource.queuedDuration, 0);
      this.audioSource.clearQueue();
    }

    this.pushedDurationMs = 0;
    this.interruptedFuture = new Future();
    this.onPlaybackFinished({
      playbackPosition: pushedDuration,
      interrupted,
    });
  }

  /**
   * Flush any buffered audio, marking the current playback/segment as complete
   */
  flush(): void {
    super.flush();

    if (!this.pushedDurationMs) {
      return;
    }

    if (this.flushTask && !this.flushTask.done) {
      this.logger.error('flush called while playback is in progress');
      this.flushTask.cancel();
    }

    this.flushTask = Task.from((controller) => this.waitForPlayoutTask(controller));
  }

  clearBuffer(): void {
    if (!this.pushedDurationMs) {
      return;
    }

    this.interruptedFuture.resolve();
  }

  private async publishTrack(signal: AbortSignal) {
    const track = LocalAudioTrack.createAudioTrack('roomio_audio', this.audioSource);
    this.publication = await this.room.localParticipant?.publishTrack(
      track,
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
    // TODO(AJS-106): add republish track
    await this.audioSource.close();
  }
}
