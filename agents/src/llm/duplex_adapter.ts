// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AudioFrame, VideoFrame } from '@livekit/rtc-node';
import type { ReadableStreamDefaultReader } from 'node:stream/web';
import { calculateAudioDurationSeconds } from '../audio.js';
import { AsyncIterableQueue, Future, shortuuid, toStream } from '../utils.js';
import { type TimedString, createTimedString } from '../voice/io.js';
import { ChatContext, ChatMessage, type FunctionCall } from './chat_context.js';
import type {
  DuplexAudioFrame,
  DuplexModel,
  DuplexOutputTranscriptDelta,
  DuplexSession,
  DuplexSessionCallbacks,
} from './duplex.js';
import {
  type GenerationCreatedEvent,
  type InputTranscriptionCompleted,
  type MessageGeneration,
  RealtimeError,
  RealtimeModel,
  type RealtimeModelError,
  RealtimeSession,
} from './realtime.js';
import type { ToolChoice, ToolContext } from './tool_context.js';
import { computeChatCtxDiff } from './utils.js';

const SILENCE_FLOOR = 1e-4;
const UNCLAIMED_TRANSCRIPT_MS = 3000;
const REPLY_TIMEOUT = 10_000;
const AUDIO_TIMEOUT = 800;
const ATTACH_LEAD_MS = 300;

/** Decides which output frames carry speech worth playing. */
export interface AudioGate {
  /** Return whether this frame belongs to an active speech burst. */
  update(frame: AudioFrame): boolean;
  /** End the current burst while retaining the learned noise floor. */
  deactivate(): void;
}

/** Thresholds and timing used to distinguish speech from silence. */
export interface AudioGateOptions {
  /** RMS level relative to the silence floor that opens the gate. Defaults to 3. */
  activationRatio?: number;
  /** RMS level relative to the silence floor that starts the quiet timer. Defaults to 1.8. */
  deactivationRatio?: number;
  /** Duration of quiet audio that ends a burst, in milliseconds. Defaults to 500. */
  minSilenceDuration?: number;
}

function rms(frame: AudioFrame): number {
  let sum = 0;
  for (const sample of frame.data) sum += sample * sample;
  return frame.data.length ? Math.sqrt(sum / frame.data.length) / 32768 : 0;
}

/** An audio gate for a provider whose silence level is known. */
export class FixedGate implements AudioGate {
  private readonly floor: number;
  private readonly activationRatio: number;
  private readonly deactivationRatio: number;
  private readonly minSilenceDuration: number;
  private open = false;
  private quiet = 0;

  /** Create a gate with a normalized PCM RMS silence level and optional thresholds. */
  constructor(silence: number, options: AudioGateOptions = {}) {
    this.floor = Math.max(silence, SILENCE_FLOOR);
    this.activationRatio = options.activationRatio ?? 3;
    this.deactivationRatio = options.deactivationRatio ?? 1.8;
    this.minSilenceDuration = options.minSilenceDuration ?? 500;
  }

  /** End the active burst while preserving the configured silence floor. */
  deactivate(): void {
    this.open = false;
    this.quiet = 0;
  }

  /** Update the gate from this frame's RMS level and audio duration. */
  update(frame: AudioFrame): boolean {
    const level = rms(frame);
    if (!this.open) {
      if (level > this.floor * this.activationRatio) {
        this.open = true;
        this.quiet = 0;
      }
    } else if (level < this.floor * this.deactivationRatio) {
      this.quiet += calculateAudioDurationSeconds(frame) * 1000;
      if (this.quiet >= this.minSilenceDuration) this.open = false;
    } else {
      this.quiet = 0;
    }
    return this.open;
  }
}

/** Options for learning a silence floor from the provider's continuous audio. */
export interface AdaptiveNoiseGateOptions extends AudioGateOptions {
  /** Duration of quiet history used to learn the floor, in milliseconds. Defaults to 10000. */
  window?: number;
}

/** Learns the noise floor from quiet stretches, so sustained speech cannot raise it. */
export class AdaptiveNoiseGate implements AudioGate {
  private readonly activationRatio: number;
  private readonly deactivationRatio: number;
  private readonly minSilenceDuration: number;
  private readonly window: number;
  private history: Array<{ level: number; duration: number }> = [];
  private historyDuration = 0;
  private stretchSum = 0;
  private stretchDuration = 0;
  private open = false;
  private quiet = 0;

  /** Create a gate that learns its silence floor from quiet audio. */
  constructor(options: AdaptiveNoiseGateOptions = {}) {
    this.activationRatio = options.activationRatio ?? 3;
    this.deactivationRatio = options.deactivationRatio ?? 1.8;
    this.minSilenceDuration = options.minSilenceDuration ?? 500;
    this.window = options.window ?? 10_000;
  }

  /** End the active burst while preserving the learned silence floor. */
  deactivate(): void {
    this.open = false;
    this.quiet = 0;
  }

  /** Update the learned floor and determine whether this frame belongs to a speech burst. */
  update(frame: AudioFrame): boolean {
    const level = rms(frame);
    const duration = calculateAudioDurationSeconds(frame) * 1000;
    if (!this.open) {
      this.stretchSum += level * duration;
      this.stretchDuration += duration;
      if (this.stretchDuration >= this.minSilenceDuration) {
        this.history.push({
          level: this.stretchSum / this.stretchDuration,
          duration: this.stretchDuration,
        });
        this.historyDuration += this.stretchDuration;
        this.stretchSum = this.stretchDuration = 0;
        while (this.historyDuration > this.window && this.history.length > 1) {
          this.historyDuration -= this.history.shift()!.duration;
        }
      }
    }

    let floor = this.stretchDuration ? this.stretchSum / this.stretchDuration : level;
    if (this.history.length) {
      floor = this.history.reduce((min, entry) => Math.min(min, entry.level), Infinity);
    }
    floor = Math.max(floor, SILENCE_FLOOR);

    if (!this.open) {
      if (level > floor * this.activationRatio) {
        this.open = true;
        this.quiet = 0;
      }
    } else if (level < floor * this.deactivationRatio) {
      this.quiet += duration;
      if (this.quiet >= this.minSilenceDuration) this.open = false;
    } else {
      this.quiet = 0;
    }
    return this.open;
  }
}

class Burst {
  readonly id = shortuuid('item_');
  readonly messages = new AsyncIterableQueue<MessageGeneration>();
  readonly functions = new AsyncIterableQueue<FunctionCall>();
  readonly text = new AsyncIterableQueue<string | TimedString>();
  readonly audio = new AsyncIterableQueue<AudioFrame>();
  readonly openedAt = Date.now();
  anchorMs?: number;
  transcript = '';
  private lastAnnotationInS = 0;

  constructor(readonly audioStartMs: number) {}

  attach(fragment: DuplexOutputTranscriptDelta): void {
    this.transcript += fragment.text;
    let text: string | TimedString = fragment.text;
    if (fragment.startMs !== undefined && this.anchorMs !== undefined) {
      const offset = this.anchorMs + this.audioStartMs;
      const startTime = Math.max(this.lastAnnotationInS, (fragment.startMs - offset) / 1000);
      const endTime =
        fragment.endMs === undefined
          ? undefined
          : Math.max(startTime, (fragment.endMs - offset) / 1000);
      this.lastAnnotationInS = endTime ?? startTime;
      // TimedString uses seconds, unlike the model's millisecond timeline.
      text = createTimedString({ text: fragment.text, startTime, endTime });
    }
    if (!this.text.closed) this.text.put(text);
  }

  close(): void {
    this.text.close();
    this.audio.close();
    this.functions.close();
    this.messages.close();
  }
}

/** Options for converting continuous duplex audio into realtime generations. */
export interface DuplexRealtimeAdapterOptions {
  /** Creates a separate gate for each session. Defaults to the model's gate or an adaptive gate. */
  gate?: () => AudioGate;
  /** Wait after the last frame's duration before ending a burst, in milliseconds. Defaults to 800. */
  audioTimeout?: number;
}

/** Segments a duplex model's continuous output into ordinary realtime generations. */
export class DuplexRealtimeAdapter extends RealtimeModel {
  /** Adapt a duplex model for the framework's realtime generation interface. */
  constructor(
    /** Continuous audio model wrapped by this adapter. */
    readonly duplexModel: DuplexModel,
    private readonly options: DuplexRealtimeAdapterOptions = {},
  ) {
    const caps = duplexModel.capabilities;
    super({
      messageTruncation: false,
      turnDetection: true,
      supportsOverlappingSpeech: true,
      userTranscription: caps.userTranscription,
      autoToolReplyGeneration: caps.autoToolReplyGeneration,
      audioOutput: true,
      manualFunctionCalls: false,
      midSessionChatCtxUpdate: caps.midSessionChatCtxUpdate ?? false,
      midSessionInstructionsUpdate: caps.midSessionInstructionsUpdate ?? false,
      midSessionToolsUpdate: caps.midSessionToolsUpdate ?? false,
      perResponseToolChoice: false,
    });
  }

  /** Model identifier reported by the wrapped provider. */
  get model(): string {
    return this.duplexModel.model;
  }

  /** Provider identifier reported by the wrapped model. */
  get provider(): string {
    return this.duplexModel.provider;
  }

  /** Create a provider session with its own audio gate and burst state. */
  session(): RealtimeSession {
    const gate = this.options.gate?.() ?? this.duplexModel.audioGate() ?? new AdaptiveNoiseGate();
    return new DuplexRealtimeSession(
      this,
      this.duplexModel.session(),
      gate,
      this.options.audioTimeout ?? AUDIO_TIMEOUT,
    );
  }

  /** Release the wrapped model's shared resources. */
  async close(): Promise<void> {
    await this.duplexModel.close();
  }
}

/** @internal */
export class DuplexRealtimeSession extends RealtimeSession {
  private burst?: Burst;
  private audioMs = 0;
  private fragments: DuplexOutputTranscriptDelta[] = [];
  private waitingSinceMs = 0;
  private pendingReply?: Future<GenerationCreatedEvent>;
  private _chatCtx = ChatContext.empty();
  private audioReader?: ReadableStreamDefaultReader<DuplexAudioFrame>;
  private readonly segmentTask: Promise<void>;
  private readonly unsubscribe: Array<() => void> = [];
  private closed = false;
  private closeTask?: Promise<void>;

  constructor(
    adapter: DuplexRealtimeAdapter,
    readonly duplexSession: DuplexSession,
    private readonly gate: AudioGate,
    private readonly audioTimeout: number,
  ) {
    super(adapter);
    this.listen('transcript_delta', (ev) => {
      if (!this.fragments.length) this.waitingSinceMs = this.audioMs;
      this.fragments.push(ev);
    });
    this.listen('function_call', (ev) => this.onFunctionCall(ev));
    this.listen('input_audio_transcription_completed', (ev) => this.onInputTranscription(ev));
    this.listen('session_reconnected', (ev) => {
      this.fragments = [];
      this.closeBurst();
      this.failPendingReply('the session reconnected before the model replied');
      this.emit('session_reconnected', ev);
    });
    this.listen('input_speech_started', (ev) => this.emit('input_speech_started', ev));
    this.listen('input_speech_stopped', (ev) => this.emit('input_speech_stopped', ev));
    this.listen('metrics_collected', (ev) => this.emit('metrics_collected', ev));
    this.listen('error', (ev) => this.emit('error', ev));
    this.segmentTask = this.segment().catch(() => {
      this.logger.error('duplex audio consumer failed');
    });
  }

  private listen<E extends keyof DuplexSessionCallbacks>(
    event: E,
    handler: DuplexSessionCallbacks[E],
  ): void {
    this.duplexSession.on(event, handler);
    this.unsubscribe.push(() => this.duplexSession.off(event, handler));
  }

  private async segment(): Promise<void> {
    let idleTimeout: NodeJS.Timeout | undefined;
    try {
      this.audioReader = this.duplexSession.audioStream.getReader();
      while (!this.closed) {
        const { value, done } = await this.audioReader.read();
        if (done || this.closed) break;
        clearTimeout(idleTimeout);
        this.onAudioFrame(value);
        if (this.burst) {
          idleTimeout = setTimeout(
            () => this.closeBurst(),
            this.audioTimeout + calculateAudioDurationSeconds(value.frame) * 1000,
          );
        }
      }
    } catch (error) {
      if (!this.closed) {
        const streamError =
          error instanceof Error ? error : new RealtimeError('duplex audio stream failed');
        this.logger.error('duplex audio stream failed');
        const ev: RealtimeModelError = {
          type: 'realtime_model_error',
          timestamp: Date.now(),
          label: this.duplexSession.duplexModel.label(),
          error: streamError,
          recoverable: false,
        };
        this.emit('error', ev);
      }
    } finally {
      clearTimeout(idleTimeout);
      this.audioReader?.releaseLock();
      this.audioReader = undefined;
      this.closeBurst();
    }
  }

  private onAudioFrame(output: DuplexAudioFrame): void {
    if (output.startMs !== undefined) this.audioMs = output.startMs;
    if (this.gate.update(output.frame)) {
      const burst = !this.burst || this.burst.audio.closed ? this.openBurst() : this.burst;
      burst.audio.put(output.frame);
      this.audioMs += Math.round(calculateAudioDurationSeconds(output.frame) * 1000);
      while (this.fragments.length) {
        const fragment = this.fragments[0]!;
        if (fragment.startMs !== undefined) {
          burst.anchorMs ??= fragment.startMs - burst.audioStartMs;
          if (fragment.startMs - burst.anchorMs > this.audioMs + ATTACH_LEAD_MS) break;
        }
        burst.attach(this.fragments.shift()!);
      }
      return;
    }

    this.audioMs += Math.round(calculateAudioDurationSeconds(output.frame) * 1000);
    if (this.burst) {
      this.closeBurst();
    } else if (
      this.fragments.length &&
      this.audioMs - this.waitingSinceMs >= UNCLAIMED_TRANSCRIPT_MS
    ) {
      this.logger.error(
        { 'lk.pii.transcript': this.fragments.map((fragment) => fragment.text).join('') },
        'duplex transcript outlived the audio it describes',
      );
      const burst = this.openBurst();
      while (this.fragments.length) burst.attach(this.fragments.shift()!);
      this.closeBurst();
    }
  }

  private openBurst(message = true): Burst {
    const burst = (this.burst = new Burst(this.audioMs));
    const ev: GenerationCreatedEvent = {
      messageStream: toStream(burst.messages),
      functionStream: toStream(burst.functions),
      userInitiated: false,
      responseId: burst.id,
    };
    if (message && this.pendingReply && !this.pendingReply.done) {
      ev.userInitiated = true;
      this.pendingReply.resolve(ev);
    }
    this.emit('generation_created', ev);
    if (message) {
      burst.messages.put({
        messageId: burst.id,
        textStream: toStream(burst.text),
        audioStream: toStream(burst.audio),
        modalities: Promise.resolve(['audio', 'text']),
      });
    }
    return burst;
  }

  private closeBurst(): void {
    const burst = this.burst;
    this.burst = undefined;
    this.gate.deactivate();
    if (burst) {
      burst.close();
      if (burst.transcript) {
        this._chatCtx.insert(
          ChatMessage.create({
            id: burst.id,
            role: 'assistant',
            content: burst.transcript,
            createdAt: burst.openedAt,
          }),
        );
      }
    }
    this.waitingSinceMs = this.audioMs;
  }

  private onInputTranscription(ev: InputTranscriptionCompleted): void {
    if (ev.isFinal) {
      this._chatCtx.insert(
        ChatMessage.create({
          id: ev.itemId,
          role: 'user',
          content: ev.transcript,
          transcriptConfidence: ev.confidence ?? 1,
          createdAt: ev.turnStartedAt,
        }),
      );
    }
    this.emit('input_audio_transcription_completed', ev);
  }

  private onFunctionCall(call: FunctionCall): void {
    this._chatCtx.insert(call);
    if (this.burst) {
      this.burst.functions.put(call);
      return;
    }
    this.openBurst(false).functions.put(call);
    this.closeBurst();
  }

  get chatCtx(): ChatContext {
    return this._chatCtx.copy();
  }

  get tools(): ToolContext {
    return this.duplexSession.tools;
  }

  async _updateSession(
    instructions?: string,
    chatCtx?: ChatContext,
    tools?: ToolContext,
  ): Promise<void> {
    if (chatCtx !== undefined) {
      chatCtx = chatCtx.copy({ excludeHandoff: true, excludeConfigUpdate: true });
      this._chatCtx = chatCtx.copy();
    }
    try {
      await this.duplexSession._updateSession(instructions, chatCtx, tools);
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async updateInstructions(instructions: string): Promise<void> {
    await this.duplexSession._updateInstructions(instructions);
  }

  async updateChatCtx(chatCtx: ChatContext): Promise<void> {
    const { removeInstructions } = await import('../voice/generation.js');
    chatCtx = chatCtx.copy({ excludeHandoff: true, excludeConfigUpdate: true });
    removeInstructions(chatCtx);
    const diff = computeChatCtxDiff(this._chatCtx, chatCtx);
    const edited = [...diff.toRemove, ...diff.toUpdate.map(([, id]) => id)].filter((id) => {
      const item = this._chatCtx.getById(id);
      return item?.type !== 'message' || item.role !== 'assistant';
    });
    if (edited.length) {
      this.logger.warn(
        { item_ids: edited },
        'duplex context is append-only; the model keeps what it has been told',
      );
    }
    const newItems = diff.toCreate.map(([, id]) => chatCtx.getById(id)!);
    if (newItems.length) await this.duplexSession._appendItems(newItems);
    this._chatCtx = chatCtx;
  }

  async updateTools(tools: ToolContext): Promise<void> {
    await this.duplexSession._updateTools(tools);
  }

  updateOptions(options: { toolChoice?: ToolChoice | null }): void {
    this.duplexSession._updateOptions(options);
  }

  pushAudio(frame: AudioFrame): void {
    this.duplexSession.pushAudio(frame);
  }

  pushVideo(frame: VideoFrame): void {
    this.duplexSession.pushVideo(frame);
  }

  async generateReply(
    instructions?: string,
    options?: { signal?: AbortSignal },
  ): Promise<GenerationCreatedEvent> {
    if (this.closed) throw new RealtimeError('the session is closed');
    const signal = options?.signal;
    const abortError = () =>
      signal?.reason instanceof Error ? signal.reason : new RealtimeError('the reply was aborted');
    if (signal?.aborted) throw abortError();
    this.duplexSession._generateReply(instructions);
    this.failPendingReply('a newer ask superseded this one');
    const reply = (this.pendingReply = new Future<GenerationCreatedEvent>());
    const timeout = setTimeout(() => {
      if (!reply.done)
        reply.reject(new RealtimeError('the model did not start speaking when asked'));
    }, REPLY_TIMEOUT);
    const onAbort = () => {
      if (!reply.done) reply.reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      return await reply.await;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
      if (this.pendingReply === reply) this.pendingReply = undefined;
    }
  }

  async commitAudio(): Promise<void> {}
  async clearAudio(): Promise<void> {}
  async interrupt(): Promise<void> {}
  async truncate(): Promise<void> {}

  private failPendingReply(reason: string): void {
    if (this.pendingReply && !this.pendingReply.done) {
      this.pendingReply.reject(new RealtimeError(reason));
    }
  }

  close(): Promise<void> {
    return (this.closeTask ??= this.closeImpl());
  }

  private async closeImpl(): Promise<void> {
    this.closed = true;
    // Release a blocked read before asking the provider to close its stream.
    this.audioReader?.releaseLock();
    await this.segmentTask;
    this.closeBurst();
    this.failPendingReply('the session closed before the model replied');
    try {
      await this.duplexSession.close();
    } catch {
      this.logger.debug('duplex session close failed');
    } finally {
      for (const unsubscribe of this.unsubscribe) unsubscribe();
      await super.close();
    }
  }
}
