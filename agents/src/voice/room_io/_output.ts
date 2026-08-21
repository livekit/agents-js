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
  stripAllMarkup,
} from '../../tts/provider_format.js';
import { Future, Task, shortuuid } from '../../utils.js';
import { AudioOutput, TextOutput, type TimedString, isTimedString } from '../io.js';
import { findMicrophoneTrackId } from '../transcription/index.js';

export interface TranscriptionOutputOptions {
  /**
   * Whether expressive markup may be present in the text reaching this sink.
   *
   * Evaluated per chunk, because the session latches it on the first turn that injects
   * the markup guide — after this sink is constructed. Defaults to "never", so a session
   * that doesn't use expressive mode publishes its transcript untouched: the strip works
   * off the union of every provider's tag names, and an agent that legitimately writes
   * `<break time="1s"/>` should not have it silently deleted.
   */
  expressiveEnabled?: () => boolean;
}

abstract class BaseParticipantTranscriptionOutput extends TextOutput {
  protected room: Room;
  protected isDeltaStream: boolean;
  protected participantIdentity: string | null = null;
  protected trackId?: string;
  protected capturing: boolean = false;
  protected latestText: string = '';
  protected currentId: string = this.generateCurrentId();
  protected logger = log();
  protected expressiveEnabled: () => boolean;

  constructor(
    room: Room,
    isDeltaStream: boolean,
    participant: Participant | string | null,
    options: TranscriptionOutputOptions = {},
  ) {
    super();
    this.room = room;
    this.isDeltaStream = isDeltaStream;
    this.expressiveEnabled = options.expressiveEnabled ?? (() => false);

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

export interface ParticipantTranscriptionOutputOptions extends TranscriptionOutputOptions {
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
  /**
   * Per-segment markup stripping: delta streams strip incrementally (buffering a tag split
   * across chunks); non-delta streams re-strip the full text each time and keep the latest
   * tags in {@link segmentTags} for the expression attribute.
   */
  private stripper = new TranscriptMarkupStripper();
  private segmentTags: ExpressiveTag[] = [];

  constructor(
    room: Room,
    isDeltaStream: boolean,
    participant: Participant | string | null,
    options: ParticipantTranscriptionOutputOptions = {},
  ) {
    super(room, isDeltaStream, participant, options);
    this.jsonFormat = options.jsonFormat ?? false;
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

    // the raw text (expressive markup intact) arrives here; publish only the visible text.
    // Skip a chunk that strips to nothing (a partial tag still buffering, or a markup-only
    // token) so the transcript cadence isn't disturbed. Without expressive there is no
    // markup to remove, so the text is published exactly as it arrives.
    const rawText = isTimedString(text) ? text.text : text;
    let cleanText: string;
    if (!this.expressiveEnabled()) {
      cleanText = rawText;
    } else if (this.isDeltaStream) {
      cleanText = this.stripper.push(rawText);
    } else {
      [cleanText, this.segmentTags] = splitAllMarkup(rawText);
      // a marker opening the segment leaves the space that followed it behind (see
      // TranscriptMarkupStripper); this path re-strips the whole accumulation each time,
      // so trimming the head is idempotent
      cleanText = cleanText.replace(/^\s+/, '');
    }
    if (!cleanText) {
      return;
    }

    // latestText must hold the encoded payload so non-delta flush (FINAL=true) republishes the
    // same newline-delimited JSON format as the interim chunks.
    const payload = this.encode(cleanText, text);
    this.latestText = payload;
    await this.publish(payload);
  }

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

  private async publish(payload: string): Promise<void> {
    try {
      if (this.room.isConnected) {
        if (this.isDeltaStream) {
          // reuse the existing writer
          if (this.writer === null) {
            // Whatever markup was stripped ahead of the first visible text goes on the
            // opening header — a frontend can't colour the turn until the agent stops
            // talking otherwise. The instructions ask for a leading expression marker, so
            // this is normally already populated.
            //
            // If the model puts prose before its first expression marker, the tag arrives
            // after this header and the segment carries no lk.expression: rtc-node's
            // `TextStreamWriter.close()` takes no attributes, so unlike Python (which
            // passes them to `aclose()`) there is no trailing header to fall back on. The
            // same limitation is why the delta path can't send lk.transcription_final
            // either. Audio and transcript text are unaffected — only the UI hint.
            this.writer = await this.createTextWriter(
              undefined,
              expressionAttribute(this.stripper.tags),
            );
          }
          await this.writer.write(payload);
        } else {
          const tmpWriter = await this.createTextWriter(
            undefined,
            expressionAttribute(this.segmentTags),
          );
          await tmpWriter.write(payload);
          await tmpWriter.close();
        }
      }
    } catch (error) {
      this.logger.error(error, 'failed to publish transcription');
    }
  }

  protected async handleCaptureText(_text: string): Promise<void> {
    // captureText is overridden above; the base implementation is unused here.
  }

  protected handleFlush() {
    const currWriter = this.writer;
    this.writer = null;
    const expressive = this.expressiveEnabled();
    // visible text left in the strip buffer
    const remaining = expressive && this.isDeltaStream ? this.stripper.flush() : '';
    const tags = !expressive ? [] : this.isDeltaStream ? this.stripper.tags : this.segmentTags;
    const pendingText = remaining ? this.encode(remaining) : '';
    this.flushTask = Task.from((controller) =>
      this.flushTaskImpl(currWriter, controller.signal, expressionAttribute(tags), pendingText),
    );
  }

  protected override resetState() {
    super.resetState();
    this.stripper = new TranscriptMarkupStripper();
    this.segmentTags = [];
  }

  private async createTextWriter(
    attributes?: Record<string, string>,
    extra?: Record<string, string>,
  ): Promise<TextStreamWriter> {
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
    // overlaid rather than replacing, so the caller can add a key without dropping the
    // transcription attributes the protocol requires
    if (extra) {
      Object.assign(attributes, extra);
    }

    return await this.room.localParticipant.streamText({
      topic: TOPIC_TRANSCRIPTION,
      senderIdentity: this.participantIdentity,
      attributes,
    });
  }

  private async flushTaskImpl(
    writer: TextStreamWriter | null,
    signal: AbortSignal,
    extraAttributes?: Record<string, string>,
    pendingText = '',
  ): Promise<void> {
    const attributes: Record<string, string> = {
      [ATTRIBUTE_TRANSCRIPTION_FINAL]: 'true',
    };
    if (this.trackId) {
      attributes[ATTRIBUTE_TRANSCRIPTION_TRACK_ID] = this.trackId;
    }
    for (const [key, value] of Object.entries(extraAttributes ?? {})) {
      attributes[key] ??= value;
    }

    const abortPromise = new Promise<void>((resolve) => {
      signal.addEventListener('abort', () => resolve());
    });

    try {
      if (this.room.isConnected) {
        if (this.isDeltaStream) {
          // a segment whose every chunk was held back by the stripper (a tag-shaped "<"
          // never resolves) reaches flush with text but no writer — open one here rather
          // than dropping the transcript
          let deltaWriter: TextStreamWriter | null = writer;
          if (!deltaWriter && pendingText) {
            const opened = await Promise.race([this.createTextWriter(attributes), abortPromise]);
            if (signal.aborted || !opened) {
              return;
            }
            deltaWriter = opened;
          }
          if (deltaWriter) {
            if (pendingText) {
              await Promise.race([deltaWriter.write(pendingText), abortPromise]);
            }
            await Promise.race([deltaWriter.close(), abortPromise]);
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
    // expression is dropped here — the deprecated rtc Transcription API has no attribute
    // channel (the stream-based output carries lk.expression instead).
    await this.publishTranscription(this.currentId, this.visibleText(), false);
  }

  /** The raw accumulation, with markup removed only when expressive could have written it. */
  private visibleText(): string {
    if (!this.expressiveEnabled()) return this.pushedText;
    // trimStart: a marker opening the segment leaves the space that followed it behind
    return stripAllMarkup(this.pushedText).replace(/^\s+/, '');
  }

  protected handleFlush() {
    if (!this.trackId) {
      return;
    }

    this.flushTask = this.publishTranscription(this.currentId, this.visibleText(), true);
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

  /** Duration of audio pushed to the source, in seconds */
  private pushedDuration: number = 0;
  private sourcePushedDuration: number = 0;
  private sourceDiscardedDuration: number = 0;
  private interruptionGeneration: number = 0;
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
    const interruptionGeneration = this.interruptionGeneration;
    if (!this.startedFuture.done) {
      await this.startedFuture.await;
      if (interruptionGeneration !== this.interruptionGeneration) {
        return;
      }
    }

    if (this.flushTask && !this.flushTask.done) {
      this.logger.error('captureFrame called while flush is in progress');
      await this.flushTask.result;
    }
    if (interruptionGeneration !== this.interruptionGeneration) {
      return;
    }

    const segmentCapture = super.captureFrame(frame);
    const frameDuration = frame.samplesPerChannel / frame.sampleRate;
    this.pushedDuration += frameDuration;
    const interruptionFuture = this.interruptedFuture;
    this.forwardingCount++;
    if (this.forwardingCount === 1 && this.forwardingIdleFuture.done) {
      this.forwardingIdleFuture = new Future();
    }

    try {
      await segmentCapture;
      if (interruptionGeneration !== this.interruptionGeneration || interruptionFuture.done) {
        return;
      }
      while (!this.playbackEnabledFuture.done) {
        const queuedDuration = this.audioSource.queuedDuration;
        this.sourceDiscardedDuration += queuedDuration / 1000;
        this.audioSource.clearQueue();
        await Promise.race([this.playbackEnabledFuture.await, interruptionFuture.await]);
        if (interruptionGeneration !== this.interruptionGeneration || interruptionFuture.done) {
          return;
        }
      }

      if (!this.firstFrameEmitted) {
        this.firstFrameEmitted = true;
        this.onPlaybackStarted(Date.now());
      }

      this.sourcePushedDuration += frameDuration;
      await this.audioSource.captureFrame(frame);
    } finally {
      this.forwardingCount--;
      if (this.forwardingCount === 0) {
        this.forwardingIdleFuture.resolve();
      }
    }
  }

  private async waitForPlayoutTask(): Promise<void> {
    const interruptionFuture = this.interruptedFuture;

    const waitForForwardingAndPlayout = async () => {
      await this.forwardingIdleFuture.await;
      await this.audioSource.waitForPlayout();
    };

    await Promise.race([waitForForwardingAndPlayout(), interruptionFuture.await]);
    const interrupted = interruptionFuture.done;
    let pushedDuration = Math.max(this.sourcePushedDuration - this.sourceDiscardedDuration, 0);

    if (interrupted) {
      pushedDuration = Math.max(pushedDuration - this.audioSource.queuedDuration / 1000, 0);
      this.audioSource.clearQueue();
    }

    this.pushedDuration = 0;
    this.sourcePushedDuration = 0;
    this.sourceDiscardedDuration = 0;
    this.firstFrameEmitted = false;
    if (this.interruptedFuture === interruptionFuture) {
      this.interruptedFuture = new Future();
    }

    this.onPlaybackFinished({ playbackPosition: pushedDuration, interrupted });
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
      return;
    }

    const flushTask = Task.from(() => this.waitForPlayoutTask());
    this.flushTask = flushTask;
    void flushTask.result.catch(() => {});
  }

  clearBuffer(): void {
    this.interruptionGeneration++;
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
