// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { type VAD, VADEventType, type VADStream, log } from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import type { CommitStrategy, VADOptions } from './stt.js';

export interface TurnDetectionOptions {
  modelId: string;
  serverVad?: VADOptions | null;
  commitStrategy?: CommitStrategy;
}

interface PendingCommitResult {
  forced: boolean;
  textUpdates: number;
}

export function resolveCommitStrategy(opts: TurnDetectionOptions): CommitStrategy {
  if (opts.commitStrategy !== undefined) return opts.commitStrategy;
  return opts.serverVad !== undefined && opts.serverVad !== null ? 'vad' : 'manual';
}

/** Defers end of speech for suspected provider-forced segment commits. */
export class TurnDetection {
  readonly #opts: TurnDetectionOptions;
  readonly #vad?: VAD;
  readonly #emitEndOfSpeech: () => void;
  readonly #logger = log();
  #vadStream?: VADStream;
  #vadClosePromise?: Promise<void>;
  #eosTimeout?: ReturnType<typeof setTimeout>;
  #vadSpeaking = false;
  #audioDurationSinceCommitInS = 0;
  #pendingClientCommits = 0;
  #lastTurnProbability?: number;
  #lastPartialText = '';
  #eosPending = false;
  #textUpdates = 0;
  #pendingCommitResults: PendingCommitResult[] = [];

  constructor(opts: { options: TurnDetectionOptions; vad?: VAD; onEndOfSpeech: () => void }) {
    this.#opts = opts.options;
    this.#vad = opts.vad;
    this.#emitEndOfSpeech = opts.onEndOfSpeech;
  }

  async start(): Promise<void> {
    await this.close();
    this.#reset();
    if (
      this.#vad &&
      this.#opts.modelId === 'scribe_v3_live' &&
      resolveCommitStrategy(this.#opts) !== 'manual'
    ) {
      try {
        this.#vadStream = this.#vad.stream();
      } catch (error) {
        this.#logger.warn(
          { error },
          'local VAD failed; disabling forced-commit guard for this connection',
        );
      }
    }
  }

  async pushFrame(frame: AudioFrame): Promise<void> {
    this.#audioDurationSinceCommitInS += frame.samplesPerChannel / frame.sampleRate;
    if (!this.#vadStream) return;
    try {
      this.#vadStream.pushFrame(frame);
    } catch (error) {
      await this.#disableVad(error);
    }
  }

  async endInput(): Promise<void> {
    if (!this.#vadStream) return;
    try {
      this.#vadStream.endInput();
    } catch (error) {
      await this.#disableVad(error);
    }
  }

  async runVad(): Promise<void> {
    const stream = this.#vadStream;
    if (!stream) return;
    try {
      for await (const event of stream) {
        if (stream !== this.#vadStream) break;
        if (event.type === VADEventType.START_OF_SPEECH) this.#vadSpeaking = true;
        if (event.type === VADEventType.END_OF_SPEECH) this.#vadSpeaking = false;
      }
    } catch (error) {
      if (stream === this.#vadStream) await this.#disableVad(error);
    }
  }

  onCommitRequested(): void {
    this.#pendingClientCommits += 1;
  }

  endSpeech(): void {
    this.#eosPending = false;
    this.cancelEosTimeout();
    this.#emitEndOfSpeech();
  }

  onPartialTranscript(probability: number | undefined, text: string): boolean {
    this.#lastTurnProbability = probability;
    const changed = Boolean(text && text !== this.#lastPartialText);
    if (changed) {
      this.#lastPartialText = text;
      this.#textUpdates += 1;
      this.cancelEosTimeout();
    }
    return changed;
  }

  onCommittedTranscript(
    data: {
      message_type?: string;
      text?: string;
    },
    finalMessageType: string,
  ): boolean {
    const messageType = data.message_type;
    const hasText = Boolean(data.text);
    let result: PendingCommitResult = { forced: false, textUpdates: this.#textUpdates };
    if (messageType === 'committed_transcript') {
      result = this.#classifyCommit(hasText);
      if (finalMessageType === 'committed_transcript_with_timestamps') {
        this.#pendingCommitResults.push(result);
      }
    } else if (
      messageType === 'committed_transcript_with_timestamps' &&
      finalMessageType === messageType
    ) {
      result = this.#pendingCommitResults.shift() ?? this.#classifyCommit(hasText);
    }

    if (messageType !== finalMessageType || !result.forced || !hasText) return false;
    this.#eosPending = true;
    if (result.textUpdates === this.#textUpdates) this.#startEosTimeout();
    return true;
  }

  cancelEosTimeout(): void {
    if (this.#eosTimeout) {
      clearTimeout(this.#eosTimeout);
      this.#eosTimeout = undefined;
    }
  }

  async close(): Promise<void> {
    if (this.#eosPending) this.endSpeech();
    this.cancelEosTimeout();
    await this.#closeVad();
  }

  /** Test hook for deterministic forced-commit scenarios. */
  _setClassifierState(state: {
    vadSpeaking?: boolean;
    audioDurationSinceCommitInS?: number;
  }): void {
    if (state.vadSpeaking !== undefined) this.#vadSpeaking = state.vadSpeaking;
    if (state.audioDurationSinceCommitInS !== undefined) {
      this.#audioDurationSinceCommitInS = state.audioDurationSinceCommitInS;
    }
  }

  #reset(): void {
    this.#vadSpeaking = false;
    this.#audioDurationSinceCommitInS = 0;
    this.#pendingClientCommits = 0;
    this.#lastTurnProbability = undefined;
    this.#lastPartialText = '';
    this.#eosPending = false;
    this.#textUpdates = 0;
    this.#pendingCommitResults = [];
  }

  #classifyCommit(hasText: boolean): PendingCommitResult {
    const forced =
      this.#opts.modelId === 'scribe_v3_live' &&
      resolveCommitStrategy(this.#opts) !== 'manual' &&
      this.#pendingClientCommits === 0 &&
      this.#audioDurationSinceCommitInS >= 34 &&
      this.#audioDurationSinceCommitInS <= 38 &&
      this.#lastTurnProbability !== undefined &&
      this.#lastTurnProbability < 0.9 &&
      this.#vadSpeaking;
    if (forced && hasText) {
      this.#logger.debug(
        {
          audioDurationSinceCommitInS: this.#audioDurationSinceCommitInS,
          turnProbability: this.#lastTurnProbability,
          vadSpeaking: this.#vadSpeaking,
        },
        'deferring end of speech for a suspected forced commit',
      );
    }
    this.#audioDurationSinceCommitInS = 0;
    this.#pendingClientCommits = Math.max(0, this.#pendingClientCommits - 1);
    this.#lastTurnProbability = undefined;
    this.#lastPartialText = '';
    return { forced, textUpdates: this.#textUpdates };
  }

  #startEosTimeout(): void {
    this.cancelEosTimeout();
    const thresholdInS = this.#opts.serverVad?.vadSilenceThresholdSecs ?? 1.5;
    const timeout = (thresholdInS + 0.5) * 1000;
    this.#eosTimeout = setTimeout(() => {
      this.#eosTimeout = undefined;
      this.#logger.warn(
        {
          eosTimeout: timeout,
          audioDurationSinceCommitInS: this.#audioDurationSinceCommitInS,
          vadSpeaking: this.#vadSpeaking,
        },
        'emitting end of speech after a suspected forced commit because no continuation transcript arrived',
      );
      this.endSpeech();
    }, timeout);
  }

  async #disableVad(error: unknown): Promise<void> {
    if (!this.#vadStream) return;
    this.#logger.warn(
      { error },
      'local VAD failed; disabling forced-commit guard for this connection',
    );
    await this.#closeVad();
  }

  async #closeVad(): Promise<void> {
    const stream = this.#vadStream;
    this.#vadStream = undefined;
    this.#vadSpeaking = false;
    if (stream) {
      this.#vadClosePromise = Promise.resolve().then(() => stream.close());
    }
    const closing = this.#vadClosePromise;
    if (!closing) return;
    try {
      await closing;
    } catch (error) {
      this.#logger.warn({ error }, 'failed to close local VAD');
    } finally {
      if (this.#vadClosePromise === closing) this.#vadClosePromise = undefined;
    }
  }
}
