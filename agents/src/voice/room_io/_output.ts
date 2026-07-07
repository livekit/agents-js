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
import {
  type ExpressiveTag,
  TranscriptMarkupStripper,
  expressionAttribute,
  splitAllMarkup,
} from '../../tts/_provider_format.js';
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
  // per-segment markup stripping: delta streams strip incrementally (buffering a tag
  // split across chunks); non-delta streams re-strip the full text each time and keep
  // the latest tags here for the expression attribute (see TranscriptMarkupStripper)
  private stripper: TranscriptMarkupStripper = new TranscriptMarkupStripper();
  private segmentTags: ExpressiveTag[] = [];

  constructor(
    room: Room,
    isDeltaStream: boolean,
    participant: Participant | string | null,
    options: ParticipantTranscriptionOutputOptions = {},
  ) {
    super(room, isDeltaStream, participant);
    this.jsonFormat = options.jsonFormat ?? false;
  }

  protected override resetState() {
    super.resetState();
    this.stripper = new TranscriptMarkupStripper();
    this.segmentTags = [];
  }

  override async captureText(text: string | TimedString) {
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

    // the raw text (expressive markup intact) arrives here; publish only the visible
    // text. Skip a chunk that strips to nothing (a partial tag still buffering, or a
    // markup-only token) so the transcript cadence isn't disturbed.
    const textStr = isTimedString(text) ? text.text : text;
    let cleanText: string;
    if (this.isDeltaStream) {
      cleanText = this.stripper.push(textStr);
    } else {
      const [clean, tags] = splitAllMarkup(textStr);
      cleanText = clean;
      this.segmentTags = tags;
    }
    if (!cleanText) {
      return;
    }

    // latestText must hold the encoded payload so non-delta flush (FINAL=true) republishes the
    // same newline-delimited JSON format as the interim chunks.
    const payload = this.encode(cleanText, text);
    this.latestText = payload;

    try {
      if (this.room.isConnected) {
        if (this.isDeltaStream) {
          // reuse the existing writer
          if (this.writer === null) {
            this.writer = await this.createTextWriter();
          }
          await this.writer.write(payload);
        } else {
          const tmpWriter = await this.createTextWriter();
          await tmpWriter.write(payload);
          await tmpWriter.close();
        }
      }
    } catch (error) {
      this.logger.error(error, 'failed to publish transcription');
    }
  }

  /** Wrap visible text for the wire (JSON TimedString when jsonFormat, else raw). */
  private encode(cleanText: string, timingSrc?: string | TimedString): string {
    if (!this.jsonFormat) {
      return cleanText;
    }

    const isTimed = timingSrc !== undefined && isTimedString(timingSrc);
    const message = new pb.TimedString({
      text: cleanText,
      startTime: isTimed ? timingSrc.startTime : undefined,
      endTime: isTimed ? timingSrc.endTime : undefined,
      confidence: isTimed ? timingSrc.confidence : undefined,
      startTimeOffset: isTimed ? timingSrc.startTimeOffset : undefined,
    });
    return message.toJsonString({ useProtoFieldName: true }) + '\n';
  }

  protected async handleCaptureText(_text: string): Promise<void> {
    // unused: captureText is fully overridden to strip markup before encoding
  }

  protected handleFlush() {
    const currWriter = this.writer;
    this.writer = null;

    // only emit on a segment that captured text (keeps lk.transcription cadence intact).
    // The leading expression the sinks stripped rides along on the closing chunk as the
    // lk.expression attribute.
    let remaining: string;
    let tags: ExpressiveTag[];
    if (this.isDeltaStream) {
      remaining = this.stripper.flush();
      tags = this.stripper.tags;
    } else {
      remaining = '';
      tags = this.segmentTags;
    }
    const pendingText = remaining ? this.encode(remaining) : '';

    this.flushTask = Task.from((controller) =>
      this.flushTaskImpl(currWriter, expressionAttribute(tags), pendingText, controller.signal),
    );
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

  private async flushTaskImpl(
    writer: TextStreamWriter | null,
    extraAttributes: Record<string, string> | undefined,
    pendingText: string,
    signal: AbortSignal,
  ): Promise<void> {
    const attributes: Record<string, string> = {
      [ATTRIBUTE_TRANSCRIPTION_FINAL]: 'true',
    };
    if (this.trackId) {
      attributes[ATTRIBUTE_TRANSCRIPTION_TRACK_ID] = this.trackId;
    }
    for (const [key, val] of Object.entries(extraAttributes ?? {})) {
      if (!(key in attributes)) {
        attributes[key] = val;
      }
    }

    const abortPromise = new Promise<void>((resolve) => {
      signal.addEventListener('abort', () => resolve());
    });

    try {
      if (this.room.isConnected) {
        if (this.isDeltaStream) {
          if (writer) {
            if (pendingText) {
              // visible text left in the strip buffer
              await Promise.race([writer.write(pendingText), abortPromise]);
              if (signal.aborted) {
                return;
              }
            }
            // NOTE: rtc-node's TextStreamWriter.close() takes no attributes yet, so the
            // lk.expression attribute cannot ride the closing chunk of a delta stream
            // (Python attaches it via `aclose(attributes=...)`).
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

    // pushedText keeps the raw text (markup intact); publish the visible text only.
    // Stripping the whole accumulation each time avoids partial-tag edge cases; the
    // expression is dropped here — the deprecated rtc Transcription API has no
    // attribute channel (the stream-based output carries lk.expression instead).
    const [cleanText] = splitAllMarkup(this.pushedText);
    await this.publishTranscription(this.currentId, cleanText, false);
  }

  protected handleFlush() {
    if (!this.trackId) {
      return;
    }

    const [cleanText] = splitAllMarkup(this.pushedText);
    this.flushTask = this.publishTranscription(this.currentId, cleanText, true);
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
  private startedFuture: Future<void> = new Future();
  private interruptedFuture: Future<void> = new Future();
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
  }

  pause(): void {
    if (this.playbackEnabledFuture.done) {
      this.playbackEnabledFuture = new Future();
    }
    // Drop already-buffered audio so playback stops promptly instead of draining the prebuffer.
    this.audioSource.clearQueue();
    super.pause();
  }

  resume(): void {
    if (!this.playbackEnabledFuture.done) {
      this.playbackEnabledFuture.resolve();
    }
    this.firstFrameEmitted = false;
    super.resume();
  }

  get subscribed(): boolean {
    return this.startedFuture.done;
  }

  async start(signal: AbortSignal): Promise<void> {
    await this.publishTrack(signal);
  }

  async captureFrame(frame: AudioFrame): Promise<void> {
    await this.startedFuture.await;

    if (!this.playbackEnabledFuture.done) {
      this.audioSource.clearQueue();
      // Race against interruption so a cancel-while-paused can't deadlock an in-flight frame.
      await Promise.race([this.playbackEnabledFuture.await, this.interruptedFuture.await]);
      if (this.interruptedFuture.done) {
        return;
      }
    }

    // Count the playback segment only after the pause/interrupt gate above. super.captureFrame
    // bumps playbackSegmentsCount; if a frame interrupted-while-paused bailed at the gate after
    // that bump, the count would strand ahead of playbackFinishedCount and the next
    // waitForPlayout() would hang forever. See #1662.
    super.captureFrame(frame);

    if (!this.firstFrameEmitted) {
      this.firstFrameEmitted = true;
      this.onPlaybackStarted(Date.now());
    }

    // TODO(AJS-102): use frame.durationMs once available in rtc-node
    this.pushedDuration += frame.samplesPerChannel / frame.sampleRate;
    await this.audioSource.captureFrame(frame);
  }

  private async waitForPlayoutTask(abortController: AbortController): Promise<void> {
    // Snapshot duration for this flush so overlapping next-segment frames are not erased on completion.
    const accountedDuration = this.pushedDuration;
    const abortFuture = new Future<boolean>();
    // Reset before the race so a stale clearBuffer() from before this segment doesn't fire it.
    this.interruptedFuture = new Future();

    const resolveAbort = () => {
      if (!abortFuture.done) abortFuture.resolve(true);
    };

    abortController.signal.addEventListener('abort', resolveAbort);

    this.audioSource.waitForPlayout().finally(() => {
      abortController.signal.removeEventListener('abort', resolveAbort);
      if (!abortFuture.done) abortFuture.resolve(false);
    });

    const aborted = await Promise.race([
      abortFuture.await,
      this.interruptedFuture.await.then(() => true),
    ]);
    const interrupted = this.interruptedFuture.done || aborted;

    let pushedDuration = accountedDuration;

    if (interrupted) {
      pushedDuration = Math.max(accountedDuration - this.audioSource.queuedDuration / 1000, 0);
      this.audioSource.clearQueue();
    }

    this.pushedDuration = 0;
    this.firstFrameEmitted = false;

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

    if (!this.pushedDuration) {
      return;
    }

    if (this.flushTask && !this.flushTask.done) {
      if (this.flushPushedDuration === this.pushedDuration) {
        return;
      }

      this.logger.error('flush called while playback is in progress');
      this.flushTask.cancel();
    }

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
    // Signal interruption even if no frame has been pushed yet, so a gated captureFrame can bail.
    if (!this.interruptedFuture.done) {
      this.interruptedFuture.resolve();
    }
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
    await this.audioSource.close();
  }
}
