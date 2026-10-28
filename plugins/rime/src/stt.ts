// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type APIConnectOptions,
  APIError,
  APITimeoutError,
  type AudioBuffer,
  DEFAULT_API_CONNECT_OPTIONS,
  type VAD,
  asLanguageCode,
  intervalForRetry,
  stt,
} from '@livekit/agents';
import { setTimeout as sleep } from 'node:timers/promises';
import { toWav } from './stt_audio.js';
import {
  type RequestOptions,
  type SDK,
  type SDKClient,
  abortable,
  cancelled,
  loadSDK,
  mapError,
} from './stt_sdk.js';
import { SpeechStream } from './stt_stream.js';

/** Rime's native streaming transcript contract.
 * @public
 */
export type STTOutputContract = 'revised_hypotheses' | 'append_fragments';
/** Defaults applied to subsequent unary requests and newly started utterances.
 * @public
 */
export interface STTUpdateOptions {
  /** BCP-47 language passed unchanged to Rime. Default: en. */
  language?: string;
  /** Formatting intent. Default: written. */
  mode?: 'written' | 'verbatim';
  /** Recognition hints, merged with framework session keyterms in stable order. */
  contextTerms?: readonly string[];
  /** Unary retry policy and overall request deadline, in milliseconds. */
  connOptions?: Partial<APIConnectOptions>;
}
/** Configuration for Rime recognition. The optional SDK requires Node.js 22+.
 * @public
 */
export interface STTOptions extends STTUpdateOptions {
  /** Defaults to RIME_API_KEY. Captured during construction. */
  apiKey?: string;
  /** Caller-owned detector enabling native streaming and interim results. */
  vad?: VAD;
  /** Default: revised_hypotheses. Append fragments require vad. */
  outputContract?: STTOutputContract;
}

function terms(value: readonly string[]): string[] {
  if (!Array.isArray(value) || value.some((term) => typeof term !== 'string'))
    throw new TypeError('contextTerms must be an array of strings');
  return [...value];
}
function connectionOptions(value?: Partial<APIConnectOptions>): APIConnectOptions {
  const result = { ...DEFAULT_API_CONNECT_OPTIONS, ...value };
  if (
    !Number.isFinite(result.timeoutMs) ||
    result.timeoutMs <= 0 ||
    !Number.isInteger(result.maxRetry) ||
    result.maxRetry < 0 ||
    !Number.isFinite(result.retryIntervalMs) ||
    result.retryIntervalMs < 0
  )
    throw new TypeError('Invalid Rime STT connection options');
  return result;
}

/** Unary recognition, or native per-utterance streaming when a VAD is supplied.
 * @public
 */
export class STT extends stt.STT {
  /** Provider label used in framework metrics. */
  label = 'rime.STT';
  private opts: Required<STTUpdateOptions>;
  private sessionKeyterms: string[] = [];
  private readonly apiKey: string;
  private readonly vad?: VAD;
  private readonly outputContract: STTOutputContract;
  private initialization?: Promise<{ sdk: SDK; client: SDKClient }>;
  private readonly cancellation = new AbortController();
  private readonly requests = new Set<Promise<stt.SpeechEvent>>();
  private readonly streams = new Set<SpeechStream>();
  private closing?: Promise<void>;

  constructor(options: STTOptions = {}) {
    super({
      streaming: !!options.vad,
      interimResults: !!options.vad,
      keyterms: true,
      alignedTranscript: false,
    });
    if (Number(process.versions.node.split('.')[0]) < 22)
      throw new Error('Rime STT requires Node.js 22 or newer');
    this.apiKey = options.apiKey ?? process.env.RIME_API_KEY ?? '';
    if (!this.apiKey.trim()) throw new Error('Provide apiKey or set RIME_API_KEY to use Rime STT');
    this.vad = options.vad;
    this.outputContract = options.outputContract ?? 'revised_hypotheses';
    if (!['revised_hypotheses', 'append_fragments'].includes(this.outputContract))
      throw new TypeError('Unsupported Rime streaming output contract');
    if (this.outputContract === 'append_fragments' && !this.vad)
      throw new TypeError('append_fragments requires a vad for streaming');
    this.opts = {
      language: 'en',
      mode: 'written',
      contextTerms: [],
      connOptions: connectionOptions(),
    };
    this.updateOptions(options);
  }

  /** Provider name. */
  override get provider(): string {
    return 'Rime';
  }

  /** Update defaults. In-flight requests and utterances retain their snapshots. */
  updateOptions(options: STTUpdateOptions): void {
    this.checkOpen();
    const next = {
      language: options.language ?? this.opts.language,
      mode: options.mode ?? this.opts.mode,
      contextTerms: terms(options.contextTerms ?? this.opts.contextTerms),
      connOptions: connectionOptions({ ...this.opts.connOptions, ...options.connOptions }),
    };
    if (typeof next.language !== 'string' || !['written', 'verbatim'].includes(next.mode))
      throw new TypeError('Invalid Rime STT language or mode');
    this.opts = next;
  }

  /** @internal */
  override _updateSessionKeyterms(keyterms: string[]): void {
    this.sessionKeyterms = terms(keyterms);
  }

  private checkOpen(): void {
    if (this.cancellation.signal.aborted) throw cancelled();
  }

  private snapshot(): { language: string; mode: 'written' | 'verbatim'; contextTerms: string[] } {
    return {
      language: this.opts.language,
      mode: this.opts.mode,
      contextTerms: [...new Set([...this.opts.contextTerms, ...this.sessionKeyterms])],
    };
  }

  private getClient(): Promise<{ sdk: SDK; client: SDKClient }> {
    this.checkOpen();
    if (!this.initialization) {
      this.initialization = (async () => {
        const sdk = await loadSDK();
        let client: SDKClient;
        try {
          client = new sdk.Rime({ apiKey: this.apiKey });
        } catch (error) {
          throw mapError(error, sdk);
        }
        if (
          typeof client.stt?.transcribe !== 'function' ||
          typeof client.stt?.stream !== 'function'
        ) {
          await client.close();
          throw new APIError('Rime STT requires @rimelabs/sdk >=0.1.0-alpha.18', {
            retryable: false,
          });
        }
        return { sdk, client };
      })();
      void this.initialization.catch(() => {});
    }
    return this.initialization;
  }

  /** Recognize one completed audio buffer using a request-specific option snapshot. */
  protected _recognize(audio: AudioBuffer, abortSignal?: AbortSignal): Promise<stt.SpeechEvent> {
    this.checkOpen();
    const snapshot = this.snapshot();
    const connection = connectionOptions(this.opts.connOptions);
    const controller = new AbortController();
    const cancel = () => controller.abort(cancelled());
    this.cancellation.signal.addEventListener('abort', cancel, { once: true });
    abortSignal?.addEventListener('abort', cancel, { once: true });
    if (abortSignal?.aborted) cancel();
    const operation = (async (): Promise<stt.SpeechEvent> => {
      let sdk: SDK | undefined;
      try {
        controller.signal.throwIfAborted();
        const wav = toWav(audio);
        for (let attempt = 0; ; attempt++) {
          const deadline = new AbortController();
          const signal = AbortSignal.any([controller.signal, deadline.signal]);
          const timer = setTimeout(
            () => deadline.abort(new APITimeoutError({ message: 'Rime STT request timed out' })),
            connection.timeoutMs,
          );
          try {
            const initialized = await abortable(this.getClient(), signal);
            sdk = initialized.sdk;
            const options: RequestOptions = {
              ...snapshot,
              timeout: connection.timeoutMs / 1000,
              signal,
            };
            // SDK settles its owned request on abort; always drain it before retrying/closing.
            const result = await initialized.client.stt.transcribe(wav, options);
            signal.throwIfAborted();
            return {
              type: stt.SpeechEventType.FINAL_TRANSCRIPT,
              requestId: result.requestId ?? '',
              alternatives: [
                {
                  text: result.text,
                  language: asLanguageCode(result.language),
                  startTime: 0,
                  endTime: 0,
                  confidence: 0,
                },
              ],
            };
          } catch (error) {
            if (controller.signal.aborted) throw mapError(error, sdk, false, cancelled());
            const mapped = mapError(
              error,
              sdk,
              false,
              signal.aborted ? mapError(signal.reason) : undefined,
            );
            if (!mapped.retryable || attempt >= connection.maxRetry) throw mapped;
          } finally {
            clearTimeout(timer);
          }
          await sleep(intervalForRetry(connection, attempt), undefined, {
            signal: controller.signal,
          });
        }
      } catch (error) {
        throw controller.signal.aborted && !(error instanceof APIError)
          ? mapError(error, sdk, false, cancelled())
          : mapError(error, sdk);
      } finally {
        this.cancellation.signal.removeEventListener('abort', cancel);
        abortSignal?.removeEventListener('abort', cancel);
      }
    })();
    this.requests.add(operation);
    void operation.then(
      () => this.requests.delete(operation),
      () => this.requests.delete(operation),
    );
    return operation;
  }

  /** Native streaming; stream connection options override plugin defaults. Never replays audio. */
  stream(options?: { connOptions?: APIConnectOptions }): stt.SpeechStream {
    this.checkOpen();
    if (!this.vad)
      throw new Error('Pass vad to rime.STT to enable native streaming, or use stt.StreamAdapter');
    const stream = new SpeechStream(
      this,
      this.vad,
      this.outputContract,
      connectionOptions(options?.connOptions ?? this.opts.connOptions),
      { getClient: () => this.getClient(), snapshot: () => this.snapshot() },
      () => this.streams.delete(stream),
    );
    this.streams.add(stream);
    return stream;
  }

  /** Cancel recognition and await all owned work. The supplied VAD remains caller-owned. */
  override close(): Promise<void> {
    if (!this.closing) {
      this.cancellation.abort(cancelled());
      this.closing = (async () => {
        await Promise.allSettled([...this.streams].map((stream) => stream.close()));
        await Promise.allSettled([...this.requests]);
        if (this.initialization) {
          const initialized = await this.initialization.catch(() => undefined);
          if (initialized) {
            try {
              await initialized.client.close();
            } catch (error) {
              throw mapError(error, initialized.sdk);
            }
          }
        }
      })();
    }
    return this.closing;
  }
}
