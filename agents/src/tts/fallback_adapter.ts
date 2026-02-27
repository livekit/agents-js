// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioResampler } from '@livekit/rtc-node';
import { APIConnectionError, APIError } from '../_exceptions.js';
import { log } from '../log.js';
import { basic } from '../tokenize/index.js';
import { type APIConnectOptions, DEFAULT_API_CONNECT_OPTIONS } from '../types.js';
import { Task, cancelAndWait } from '../utils.js';
import { StreamAdapter } from './stream_adapter.js';
import { ChunkedStream, SynthesizeStream, TTS, type TTSCapabilities } from './tts.js';

/**
 * Internal status tracking for each TTS instance.
 * @internal
 */
interface TTSStatus {
  available: boolean;
  recoveringTask: Task<void> | null;
}

/**
 * Options for creating a FallbackAdapter.
 */
export interface FallbackAdapterOptions {
  /** List of TTS instances to use for fallback (in priority order). At least one is required. */
  ttsInstances: TTS[];
  /** Number of internal retries per TTS instance before moving to the next one. Defaults to 2. */
  maxRetryPerTTS?: number;
  /** Delay in milliseconds before attempting to recover a failed TTS instance. Defaults to 1000. */
  recoveryDelayMs?: number;
}

/**
 * Event emitted when a TTS instance's availability changes.
 */
export interface AvailabilityChangedEvent {
  /** The TTS instance whose availability changed. */
  tts: TTS;
  /** Whether the TTS instance is now available. */
  available: boolean;
}

const DEFAULT_FALLBACK_API_CONNECT_OPTIONS: APIConnectOptions = {
  maxRetry: 0,
  timeoutMs: DEFAULT_API_CONNECT_OPTIONS.timeoutMs,
  retryIntervalMs: DEFAULT_API_CONNECT_OPTIONS.retryIntervalMs,
};

const FORWARD_POLL_MS = 10;

/**
 * FallbackAdapter is a TTS wrapper that provides automatic failover between multiple TTS providers.
 *
 * When the primary TTS fails, it automatically switches to the next available provider in the list.
 * Failed providers are monitored in the background and restored when they recover.
 *
 * Features:
 * - Automatic failover to backup TTS providers on failure
 * - Background health checks to restore recovered providers
 * - Automatic audio resampling when TTS providers have different sample rates
 * - Support for both streaming and non-streaming TTS providers
 *
 * @example
 * ```typescript
 * import { FallbackAdapter } from '@livekit/agents';
 * import { TTS as OpenAITTS } from '@livekit/agents-plugin-openai';
 * import { TTS as ElevenLabsTTS } from '@livekit/agents-plugin-elevenlabs';
 *
 * const fallbackTTS = new FallbackAdapter({
 *   ttsInstances: [
 *     new OpenAITTS(),      // Primary
 *     new ElevenLabsTTS(),  // Fallback
 *   ],
 *   maxRetryPerTTS: 2,      // Retry each TTS twice before moving to next
 *   recoveryDelayMs: 1000,  // Check recovery every 1 second
 * });
 *
 * ```
 */
export class FallbackAdapter extends TTS {
  /** The list of TTS instances used for fallback (in priority order). */
  readonly ttsInstances: TTS[];
  /** Number of retries per TTS instance before falling back to the next one. */
  readonly maxRetryPerTTS: number;
  /** Delay in milliseconds before attempting to recover a failed TTS instance. */
  readonly recoveryDelayMs: number;

  private _status: TTSStatus[] = [];
  private _logger = log();
  private _recoveryTimeouts: Map<number, NodeJS.Timeout> = new Map();

  label: string = `tts.FallbackAdapter`;

  constructor(opts: FallbackAdapterOptions) {
    if (!opts.ttsInstances || opts.ttsInstances.length < 1) {
      throw new Error('at least one TTS instance must be provided.');
    }
    const numChannels = opts.ttsInstances[0]!.numChannels;
    const allNumChannelsMatch = opts.ttsInstances.every((tts) => tts.numChannels === numChannels);
    if (!allNumChannelsMatch) {
      throw new Error('All TTS instances should have the same number of channels');
    }
    const sampleRate = Math.max(...opts.ttsInstances.map((t) => t.sampleRate));
    const capabilities = FallbackAdapter.aggregateCapabilities(opts.ttsInstances);
    super(sampleRate, numChannels, capabilities);
    this.ttsInstances = opts.ttsInstances;
    this.maxRetryPerTTS = opts.maxRetryPerTTS ?? 2;
    this.recoveryDelayMs = opts.recoveryDelayMs ?? 1000;
    this._status = opts.ttsInstances.map(() => ({
      available: true,
      recoveringTask: null,
    }));
    this.setupEventForwarding();
  }
  private static aggregateCapabilities(instances: TTS[]): TTSCapabilities {
    const streaming = instances.some((tts) => tts.capabilities.streaming);
    const alignedTranscript = instances.every((tts) => tts.capabilities.alignedTranscript === true);
    return { streaming, alignedTranscript };
  }

  private setupEventForwarding(): void {
    this.ttsInstances.forEach((tts) => {
      tts.on('metrics_collected', (metrics) => {
        this.emit('metrics_collected', metrics);
      });
      tts.on('error', (error) => {
        this.emit('error', error);
      });
    });
  }

  /**
   * Returns the current status of all TTS instances, including availability and recovery state.
   */
  get status(): TTSStatus[] {
    return this._status;
  }

  getStreamingInstance(index: number): TTS {
    const tts = this.ttsInstances[index]!;
    if (tts.capabilities.streaming) {
      return tts;
    }
    // Wrap non-streaming TTS with StreamAdapter
    return new StreamAdapter(tts, new basic.SentenceTokenizer());
  }

  /**
   * Creates a new AudioResampler for the given TTS index if needed.
   * Returns null if the TTS sample rate matches the adapter's output rate.
   * Each stream should create its own resampler to avoid concurrency issues.
   * @internal
   */
  createResamplerForTTS(index: number): AudioResampler | null {
    const tts = this.ttsInstances[index]!;
    if (this.sampleRate !== tts.sampleRate) {
      this._logger.debug(
        `resampling ${tts.label} from ${tts.sampleRate}Hz to ${this.sampleRate}Hz`,
      );
      return new AudioResampler(tts.sampleRate, this.sampleRate, tts.numChannels);
    }
    return null;
  }

  private emitAvailabilityChanged(tts: TTS, available: boolean): void {
    const event: AvailabilityChangedEvent = { tts, available };
    (this as unknown as { emit: (event: string, data: AvailabilityChangedEvent) => void }).emit(
      'tts_availability_changed',
      event,
    );
  }

  private tryRecovery(index: number): void {
    const status = this._status[index]!;
    const tts = this.ttsInstances[index]!;
    if (status.recoveringTask && !status.recoveringTask.done) {
      return;
    }
    status.recoveringTask = Task.from(async (controller) => {
      try {
        const testStream = tts.synthesize(
          'Hello world, this is a recovery test.',
          {
            maxRetry: 0,
            timeoutMs: 10000,
            retryIntervalMs: 1000,
          },
          controller.signal,
        );
        let audioReceived = false;
        for await (const _ of testStream) {
          audioReceived = true;
        }
        if (!audioReceived) {
          throw new Error('Recovery test completed but no audio was received');
        }

        status.available = true;
        status.recoveringTask = null;
        this._logger.info({ tts: tts.label }, 'TTS recovered');
        this.emitAvailabilityChanged(tts, true);
      } catch (error) {
        status.recoveringTask = null;
        // Don't schedule retry if we're shutting down
        if (controller.signal.aborted) {
          return;
        }
        this._logger.debug({ tts: tts.label, error }, 'TTS recovery failed, will retry');
        // Retry recovery after delay (matches Python's retry behavior)
        const timeoutId = setTimeout(() => {
          this._recoveryTimeouts.delete(index);
          this.tryRecovery(index);
        }, this.recoveryDelayMs);
        this._recoveryTimeouts.set(index, timeoutId);
      }
    });
  }

  markUnAvailable(index: number): void {
    const status = this._status[index]!;
    if (status.recoveringTask && !status.recoveringTask.done) {
      return;
    }
    if (status.available) {
      status.available = false;
      this.emitAvailabilityChanged(this.ttsInstances[index]!, false);
    }
    this.tryRecovery(index);
  }

  /**
   * Receives text and returns synthesis in the form of a {@link ChunkedStream}
   */
  synthesize(
    text: string,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ): ChunkedStream {
    return new FallbackChunkedStream(
      this,
      text,
      connOptions ?? DEFAULT_FALLBACK_API_CONNECT_OPTIONS,
      abortSignal,
    );
  }

  /**
   * Returns a {@link SynthesizeStream} that can be used to push text and receive audio data
   *
   * @param options - Optional configuration including connection options
   */
  stream(options?: { connOptions?: APIConnectOptions }): SynthesizeStream {
    return new FallbackSynthesizeStream(
      this,
      options?.connOptions ?? DEFAULT_FALLBACK_API_CONNECT_OPTIONS,
    );
  }

  /**
   * Close the FallbackAdapter and all underlying TTS instances.
   * This cancels any ongoing recovery tasks and cleans up resources.
   */
  async close(): Promise<void> {
    // clear all recovery timeouts so that it does not cause issue
    this._recoveryTimeouts.forEach((timeoutId) => {
      clearTimeout(timeoutId);
    });
    this._recoveryTimeouts.clear();

    // Cancel all recovery tasks
    const recoveryTasks = this._status
      .map((s) => s.recoveringTask)
      .filter((t): t is Task<void> => t !== null);

    if (recoveryTasks.length > 0) {
      await cancelAndWait(recoveryTasks, 1000);
    }

    // Remove event listeners
    for (const tts of this.ttsInstances) {
      tts.removeAllListeners('metrics_collected');
      tts.removeAllListeners('error');
    }

    // Close all TTS instances
    await Promise.all(this.ttsInstances.map((tts) => tts.close()));
  }
}

class FallbackChunkedStream extends ChunkedStream {
  private adapter: FallbackAdapter;
  private connOptions: APIConnectOptions;
  private _logger = log();

  label: string = 'tts.FallbackChunkedStream';

  constructor(
    adapter: FallbackAdapter,
    text: string,
    connOptions: APIConnectOptions,
    abortSignal?: AbortSignal,
  ) {
    super(text, adapter, connOptions, abortSignal);
    this.adapter = adapter;
    this.connOptions = connOptions;
  }

  protected async run(): Promise<void> {
    const allTTSFailed = this.adapter.status.every((s) => !s.available);
    let lastRequestId: string = '';
    let lastSegmentId: string = '';
    if (allTTSFailed) {
      this._logger.warn('All fallback TTS instances failed, retrying from first...');
    }
    for (let i = 0; i < this.adapter.ttsInstances.length; i++) {
      const tts = this.adapter.ttsInstances[i]!;
      const status = this.adapter.status[i]!;
      if (!status.available && !allTTSFailed) {
        this.adapter.markUnAvailable(i);
        continue;
      }
      try {
        this._logger.debug({ tts: tts.label }, 'attempting TTS synthesis');
        const connOptions: APIConnectOptions = {
          ...this.connOptions,
          maxRetry: this.adapter.maxRetryPerTTS,
        };
        const stream = tts.synthesize(this.inputText, connOptions, this.abortSignal);
        let audioReceived = false;
        const resampler = this.adapter.createResamplerForTTS(i);
        for await (const audio of stream) {
          if (this.abortController.signal.aborted) {
            stream.close();
            return;
          }

          if (resampler) {
            for (const frame of resampler.push(audio.frame)) {
              this.queue.put({
                ...audio,
                frame,
              });
              audioReceived = true;
            }
          } else {
            this.queue.put(audio);
            audioReceived = true;
          }
          lastRequestId = audio.requestId;
          lastSegmentId = audio.segmentId;
        }

        // Flush any remaining resampled frames
        if (resampler) {
          for (const frame of resampler.flush()) {
            this.queue.put({
              requestId: lastRequestId || '',
              segmentId: lastSegmentId || '',
              frame,
              final: true,
            });
            audioReceived = true;
          }
        }

        // Verify audio was actually received - silent failures should trigger fallback
        if (!audioReceived) {
          throw new APIConnectionError({
            message: 'TTS synthesis completed but no audio was received',
          });
        }

        this._logger.debug({ tts: tts.label }, 'TTS synthesis succeeded');
        return;
      } catch (error) {
        if (error instanceof APIError || error instanceof APIConnectionError) {
          this._logger.warn({ tts: tts.label, error }, 'TTS failed, switching to next instance');
          this.adapter.markUnAvailable(i);
        } else {
          throw error;
        }
      }
    }
    const labels = this.adapter.ttsInstances.map((t) => t.label).join(', ');
    throw new APIConnectionError({
      message: `all TTS instances failed (${labels})`,
    });
  }
}

class FallbackSynthesizeStream extends SynthesizeStream {
  private adapter: FallbackAdapter;
  private tokenBuffer: (
    | string
    | typeof SynthesizeStream.FLUSH_SENTINEL
    | typeof SynthesizeStream.END_OF_STREAM
  )[] = [];
  private audioPushed = false;
  private _logger = log();

  label: string = 'tts.FallbackSynthesizeStream';

  constructor(adapter: FallbackAdapter, connOptions: APIConnectOptions) {
    super(adapter, connOptions);
    this.adapter = adapter;
  }

  protected async run(): Promise<void> {
    const allTTSFailed = this.adapter.status.every((s) => !s.available);
    if (allTTSFailed) {
      this._logger.warn('All fallback TTS instances failed, retrying from first...');
    }
    const readInputLLMStream = (async () => {
      try {
        for await (const input of this.input) {
          if (this.abortController.signal.aborted) break;
          this.tokenBuffer.push(input);
        }
      } catch (error) {
        this._logger.debug({ error }, 'Error reading input LLM stream');
        throw error;
      } finally {
        this.tokenBuffer.push(SynthesizeStream.END_OF_STREAM);
      }
    })();

    for (let i = 0; i < this.adapter.ttsInstances.length; i++) {
      const tts = this.adapter.getStreamingInstance(i);
      const originalTts = this.adapter.ttsInstances[i]!;
      const status = this.adapter.status[i]!;
      let lastRequestId: string = '';
      let lastSegmentId: string = '';

      if (!status.available && !allTTSFailed) {
        this.adapter.markUnAvailable(i);
        continue;
      }

      try {
        this._logger.debug({ tts: originalTts.label }, 'attempting TTS stream');

        const connOptions: APIConnectOptions = {
          ...this.connOptions,
          maxRetry: this.adapter.maxRetryPerTTS,
        };

        const stream = tts.stream({ connOptions });
        const resampler = this.adapter.createResamplerForTTS(i);
        let bufferIndex = 0;
        let streamOutputCompleted = false;
        const forwardBufferToTTS = async () => {
          while (true) {
            while (bufferIndex < this.tokenBuffer.length) {
              const token = this.tokenBuffer[bufferIndex++]!;
              if (token === SynthesizeStream.FLUSH_SENTINEL) {
                stream.flush();
              } else if (token === SynthesizeStream.END_OF_STREAM) {
                stream.endInput();
                return;
              } else {
                stream.pushText(token);
              }
            }
            await new Promise((resolve) => setTimeout(resolve, FORWARD_POLL_MS));
            if (this.abortController.signal.aborted || streamOutputCompleted) {
              stream.endInput();
              return;
            }
          }
        };

        const processOutput = async () => {
          try {
            for await (const audio of stream) {
              if (this.abortController.signal.aborted) {
                stream.close();
                return;
              }

              if (audio === SynthesizeStream.END_OF_STREAM) {
                // Don't forward END_OF_STREAM yet — only emit after we verify audio
                // was received. Otherwise a silent failure would signal completion
                // to consumers before fallback can try the next TTS.
                continue;
              }

              if (resampler) {
                for (const frame of resampler.push(audio.frame)) {
                  this.queue.put({
                    ...audio,
                    frame,
                  });
                  this.audioPushed = true;
                }
              } else {
                this.queue.put(audio);
                this.audioPushed = true;
              }
              lastRequestId = audio.requestId;
              lastSegmentId = audio.segmentId;
            }

            // Flush resampler
            if (resampler) {
              for (const frame of resampler.flush()) {
                this.queue.put({
                  requestId: lastRequestId || '',
                  segmentId: lastSegmentId || '',
                  frame,
                  final: true,
                });
                this.audioPushed = true;
              }
            }
          } finally {
            // processOutput and forwardBufferToTTS run in parallel.
            // forwardBufferToTTS polls tokenBuffer and only exits when it sees END_OF_STREAM.
            // But END_OF_STREAM is only added when the LLM finishes streaming (line 417).
            // If the TTS fails while the LLM is still streaming, forwardBufferToTTS would
            // keep polling indefinitely, blocking fallback to the next TTS.
            // This flag tells it to exit early.
            streamOutputCompleted = true;
          }
        };
        const [outputResult, forwardBufferResult] = await Promise.allSettled([
          processOutput(),
          forwardBufferToTTS().catch((err) => {
            stream.close(); // Close stream so processOutput can exit
            throw err;
          }),
        ]);
        if (outputResult.status === 'rejected') {
          stream.close();
          throw outputResult.reason;
        }
        if (forwardBufferResult.status === 'rejected') {
          stream.close();
          throw forwardBufferResult.reason;
        }

        // Verify audio was actually received - if not, the TTS failed silently
        if (!this.audioPushed) {
          throw new APIConnectionError({
            message: 'TTS stream completed but no audio was received',
          });
        }

        this.queue.put(SynthesizeStream.END_OF_STREAM);
        this._logger.debug({ tts: originalTts.label }, 'TTS stream succeeded');
        await readInputLLMStream.catch(() => {});
        return;
      } catch (error) {
        if (this.audioPushed) {
          this._logger.error(
            { tts: originalTts.label },
            'TTS failed after audio pushed, cannot fallback mid-utterance',
          );
          throw error;
        }

        if (error instanceof APIError || error instanceof APIConnectionError) {
          this._logger.warn(
            { tts: originalTts.label, error },
            'TTS failed, switching to next instance',
          );
          this.adapter.markUnAvailable(i);
        } else {
          throw error;
        }
      }
    }
    await readInputLLMStream.catch(() => {});
    const labels = this.adapter.ttsInstances.map((t) => t.label).join(', ');
    throw new APIConnectionError({
      message: `all TTS instances failed (${labels})`,
    });
  }
}
