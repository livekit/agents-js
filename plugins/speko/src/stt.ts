// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AudioBuffer } from '@livekit/agents';
import { type APIConnectOptions, asLanguageCode, stt } from '@livekit/agents';
import type { PipelineConstraints, Speko } from '@spekoai/sdk';
import { framesToWav } from './audio.js';
import { type SpekoClientOptions, createSpekoClient } from './client.js';
import { type Intent, validateIntent } from './intent.js';

/**
 * Options for the Speko STT component.
 *
 * @public
 */
export interface STTOptions extends SpekoClientOptions {
  /** Routing hint sent with every transcription. */
  intent: Intent;
  /** Optional allow-list constraints. */
  constraints?: PipelineConstraints;
  /**
   * Optional domain keywords forwarded to the underlying provider for
   * vocabulary biasing. Casing is preserved for proper nouns.
   */
  keywords?: readonly string[];
}

/**
 * LiveKit Agents STT plugin that delegates recognition to the Speko proxy
 * (`POST /v1/transcribe`). The Speko router picks the best STT provider per
 * `(language, region, optimizeFor)` and handles failover.
 *
 * Declares `{ streaming: false }` because this plugin uploads one
 * VAD-bounded WAV per recognition call. The underlying `/v1/transcribe`
 * response streams transcript events, and the SDK aggregates the final result
 * for `_recognize()`. `voice.AgentSession` wraps non-streaming STT plugins with
 * `stt.StreamAdapter` automatically when a VAD is configured.
 *
 * @public
 */
export class STT extends stt.STT {
  /** Human-readable model label used by LiveKit metrics and logs. */
  label = 'speko.STT';
  readonly #speko: Speko;
  readonly #intent: Intent;
  readonly #constraints: PipelineConstraints | undefined;
  readonly #keywords: readonly string[] | undefined;

  constructor(options: STTOptions) {
    super({ streaming: false, interimResults: false });
    validateIntent(options.intent);
    this.#speko = createSpekoClient(options);
    this.#intent = options.intent;
    this.#constraints = options.constraints;
    this.#keywords = options.keywords && options.keywords.length > 0 ? options.keywords : undefined;
  }

  /** Provider identifier reported to LiveKit metrics. */
  override get provider(): string {
    return 'speko';
  }

  /** Model identifier reported to LiveKit metrics. */
  override get model(): string {
    return 'speko-router';
  }

  /** Recognize one VAD-bounded utterance by uploading it to Speko as WAV. */
  protected async _recognize(
    frame: AudioBuffer,
    abortSignal?: AbortSignal,
  ): Promise<stt.SpeechEvent> {
    const wav = framesToWav(frame);
    const result = await this.#speko.transcribe(
      wav,
      {
        language: this.#intent.language,
        ...(this.#intent.region !== undefined && { region: this.#intent.region }),
        ...(this.#intent.optimizeFor !== undefined && {
          optimizeFor: this.#intent.optimizeFor,
        }),
        contentType: 'audio/wav',
        ...(this.#constraints !== undefined && { constraints: this.#constraints }),
        ...(this.#keywords !== undefined && { keywords: this.#keywords }),
      },
      abortSignal,
    );

    return {
      type: stt.SpeechEventType.FINAL_TRANSCRIPT,
      alternatives: [
        {
          text: result.text,
          language: asLanguageCode(this.#intent.language),
          startTime: 0,
          endTime: 0,
          confidence: result.confidence ?? 1,
        },
      ],
    };
  }

  /**
   * Native microphone streaming is not supported; LiveKit wraps this STT with
   * `stt.StreamAdapter` when used in `voice.AgentSession` with a VAD.
   */
  override stream(_options?: { connOptions?: APIConnectOptions }): stt.SpeechStream {
    throw new Error(
      'speko.STT does not support native microphone streaming; it uploads one VAD-bounded utterance. ' +
        'Pass it directly to `voice.AgentSession` with a VAD, or wrap it manually ' +
        'with `new stt.StreamAdapter(spekoStt, vad)` when implementing a custom STT node.',
    );
  }
}
