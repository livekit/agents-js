// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { APIConnectionError, APIError } from '../_exceptions.js';
import { log } from '../log.js';
import type { TTSMetrics } from '../metrics/base.js';
import { type APIConnectOptions, DEFAULT_API_CONNECT_OPTIONS } from '../types.js';
import { AsyncIterableQueue } from '../utils.js';
import type { SentenceTokenizer } from '../tokenize/index.js';
import { StreamAdapter } from './stream_adapter.js';
import {
    ChunkedStream,
    SynthesizeStream,
    TTS,
    type SynthesizedAudio,
    type TTSCapabilities,
} from './tts.js';

/**
 * Default connection options for FallbackAdapter.
 * Uses maxRetry=0 since fallback handles retries at a higher level.
 */
const DEFAULT_FALLBACK_API_CONNECT_OPTIONS: APIConnectOptions = {
    maxRetry: 0,
    timeoutMs: DEFAULT_API_CONNECT_OPTIONS.timeoutMs,
    retryIntervalMs: DEFAULT_API_CONNECT_OPTIONS.retryIntervalMs,
};

/**
 * Internal status tracking for each TTS instance.
 */
interface TTSStatus {
    available: boolean;
    recoveringTask: Promise<void> | null;
}

/**
 * Event emitted when a TTS provider's availability changes.
 */
export interface TTSAvailabilityChangedEvent {
    tts: TTS;
    available: boolean;
}

/**
 * Options for creating a TTS FallbackAdapter.
 */
export interface FallbackAdapterOptions {
    /** List of TTS instances to fallback to (in order). */
    tts: TTS[];
    /** Timeout for each TTS attempt in seconds. Defaults to 10.0. */
    attemptTimeout?: number;
    /** Internal retries per TTS before moving to next. Defaults to 0. */
    maxRetryPerTts?: number;
    /** Interval between retries in seconds. Defaults to 0.5. */
    retryInterval?: number;
    /**
     * Don't fallback to next provider after this much audio (in seconds) has been generated.
     * Once the user has heard significant audio, switching providers may be jarring.
     * Defaults to 3.0 seconds.
     */
    noFallbackAfterAudioDuration?: number;
    /**
     * Sentence tokenizer for wrapping non-streaming TTS providers with StreamAdapter.
     * Required if any TTS provider has streaming=false and you want to use stream() calls.
     * When provided, non-streaming providers will be automatically wrapped to support streaming.
     */
    sentenceTokenizer?: SentenceTokenizer;
    /** Interval between recovery attempts in seconds. Defaults to 30. */
    recoveryInterval?: number;
    /** Maximum recovery attempts before giving up. Defaults to 10. */
    maxRecoveryAttempts?: number;
}

/**
 * FallbackAdapter is a TTS that can fallback to a different TTS provider if the current one fails.
 *
 * @example
 * ```typescript
 * const fallbackTTS = new FallbackAdapter({
 *   tts: [primaryTTS, secondaryTTS, tertiaryTTS],
 *   attemptTimeout: 10.0,
 *   maxRetryPerTts: 1,
 * });
 * ```
 */
export class FallbackAdapter extends TTS {
    label = 'tts.FallbackAdapter';

    readonly ttsProviders: TTS[];
    readonly attemptTimeout: number;
    readonly maxRetryPerTts: number;
    readonly retryInterval: number;
    readonly noFallbackAfterAudioDuration: number;
    readonly sentenceTokenizer?: SentenceTokenizer;
    readonly recoveryInterval: number;
    readonly maxRecoveryAttempts: number;

    /** @internal */
    _status: TTSStatus[];

    private logger = log();

    constructor(options: FallbackAdapterOptions) {
        const first = options.tts[0];
        if (!first) {
            throw new Error('at least one TTS instance must be provided.');
        }

        // Streaming: use any() - true if ANY provider supports streaming
        // Non-streaming providers will be wrapped with StreamAdapter when needed
        const streaming = options.tts.some((t) => t.capabilities.streaming);
        // Aligned transcript: use every() - all must support for consistent behavior
        const alignedTranscript = options.tts.every((t) => t.capabilities.alignedTranscript);
        const capabilities: TTSCapabilities = { streaming, alignedTranscript };

        // Use the first provider's audio settings; assume all are compatible
        super(first.sampleRate, first.numChannels, capabilities);

        this.ttsProviders = options.tts;
        this.attemptTimeout = options.attemptTimeout ?? 10.0;
        this.maxRetryPerTts = options.maxRetryPerTts ?? 0;
        this.retryInterval = options.retryInterval ?? 0.5;
        this.noFallbackAfterAudioDuration = options.noFallbackAfterAudioDuration ?? 3.0;
        this.sentenceTokenizer = options.sentenceTokenizer;
        this.recoveryInterval = options.recoveryInterval ?? 30;
        this.maxRecoveryAttempts = options.maxRecoveryAttempts ?? 10;

        // Initialize status for each TTS
        this._status = this.ttsProviders.map(() => ({
            available: true,
            recoveringTask: null,
        }));

        // Forward metrics_collected events from child TTS providers
        for (const ttsProvider of this.ttsProviders) {
            (ttsProvider as unknown as { on: (event: string, cb: (m: TTSMetrics) => void) => void }).on(
                'metrics_collected',
                (metrics: TTSMetrics) => {
                    (this as unknown as { emit: (event: string, data: TTSMetrics) => void }).emit(
                        'metrics_collected',
                        metrics,
                    );
                },
            );
        }

    }

    synthesize(
        text: string,
        connOptions?: APIConnectOptions,
        abortSignal?: AbortSignal,
    ): ChunkedStream {
        return new FallbackChunkedStream(
            text,
            this,
            connOptions ?? DEFAULT_FALLBACK_API_CONNECT_OPTIONS,
            abortSignal,
        );
    }

    stream(options?: { connOptions?: APIConnectOptions }): SynthesizeStream {
        return new FallbackSynthesizeStream(
            this,
            options?.connOptions ?? DEFAULT_FALLBACK_API_CONNECT_OPTIONS,
        );
    }

    /**  
 * Attempt to recover a failed TTS provider  
 * @internal  
 */
    private async recoverProvider(ttsIndex: number): Promise<void> {
        const tts = this.ttsProviders[ttsIndex]!;
        const status = this._status[ttsIndex]!;
        let attempts = 0;

        while (attempts < this.maxRecoveryAttempts && !status.available) {
            attempts++;

            try {
                // Test with a simple synthesis  
                const testStream = tts.synthesize("test", {
                    maxRetry: 0,
                    timeoutMs: 5000,
                    retryIntervalMs: 0,
                });

                // Try to get first audio frame  
                for await (const audio of testStream) {
                    // Success if we get any audio  
                    status.available = true;
                    status.recoveringTask = null;
                    this._emitAvailabilityChanged(tts, true);
                    this.logger.info(
                        { tts: tts.label, attempts },
                        'FallbackAdapter: TTS provider recovered'
                    );
                    return;
                }
            } catch (error) {
                this.logger.debug(
                    { tts: tts.label, attempts, error },
                    'FallbackAdapter: Recovery attempt failed'
                );
            }

            // Wait before next attempt (with exponential backoff)  
            const delay = Math.min(this.recoveryInterval * Math.pow(2, attempts - 1), 300);
            await new Promise(resolve => setTimeout(resolve, delay * 1000));
        }
        status.recoveringTask = null;
        this.logger.error(
            { tts: tts.label, attempts },
            'FallbackAdapter: Failed to recover TTS provider after max attempts'
        );
    }



    /**
     * Emit availability changed event.
     * @internal
     */
    _emitAvailabilityChanged(tts: TTS, available: boolean): void {
        const event: TTSAvailabilityChangedEvent = { tts, available };
        (this as unknown as { emit: (event: string, data: TTSAvailabilityChangedEvent) => void }).emit(
            'tts_availability_changed',
            event,
        );
    }

    /**  
   * Start recovery for a failed provider  
   * @internal  
   */
    private _startRecovery(ttsIndex: number): void {
        const status = this._status[ttsIndex]!;

        if (!status.recoveringTask && !status.available) {
            status.recoveringTask = this.recoverProvider(ttsIndex);
        }
    }

    override async close(): Promise<void> {
        await Promise.all(this.ttsProviders.map((tts) => tts.close()));
    }
}

/**
 * ChunkedStream implementation for FallbackAdapter.
 * Handles fallback logic for non-streaming synthesis.
 */
class FallbackChunkedStream extends ChunkedStream {
    label = 'tts.FallbackChunkedStream';

    private adapter: FallbackAdapter;
    private _log = log();

    constructor(
        text: string,
        adapter: FallbackAdapter,
        connOptions: APIConnectOptions,
        abortSignal?: AbortSignal,
    ) {
        super(text, adapter, connOptions, abortSignal);
        this.adapter = adapter;
    }

    /**
     * Try to synthesize with a single TTS provider.
     */
    private async *trySynthesize(
        tts: TTS,
        text: string,
        connOptions: APIConnectOptions,
    ): AsyncGenerator<SynthesizedAudio, void, unknown> {
        const stream = tts.synthesize(text, connOptions, this.abortSignal);

        try {
            for await (const audio of stream) {
                yield audio;
            }
        } catch (error) {
            if (error instanceof APIError) {
                this._log.warn({ tts: tts.label, error }, 'TTS failed, switching to next provider');
                throw error;
            }

            if (error instanceof Error && error.name === 'AbortError') {
                this._log.warn({ tts: tts.label }, 'TTS timed out, switching to next provider');
                throw error;
            }

            this._log.error({ tts: tts.label, error }, 'TTS unexpected error, switching to next provider');
            throw error;
        } finally {
            stream.close();
        }
    }

    /**
     * Main run method - iterates through TTS providers with fallback logic.
     */
    protected async run(): Promise<void> {
        const startTime = Date.now();
        const text = this.inputText;

        // Check if all TTS providers are unavailable
        const allFailed = this.adapter._status.every((s) => !s.available);
        if (allFailed) {
            this._log.error('all TTS providers are unavailable, retrying...');
        }

        for (let i = 0; i < this.adapter.ttsProviders.length; i++) {
            const tts = this.adapter.ttsProviders[i]!;
            const status = this.adapter._status[i]!;

            this._log.debug(
                { tts: tts.label, index: i, available: status.available, allFailed },
                'checking TTS provider',
            );

            if (status.available || allFailed) {
                let audioDurationSent = 0;

                const connOptions: APIConnectOptions = {
                    maxRetry: this.adapter.maxRetryPerTts,
                    timeoutMs: this.adapter.attemptTimeout * 1000,
                    retryIntervalMs: this.adapter.retryInterval * 1000,
                };

                try {
                    this._log.info({ tts: tts.label }, 'FallbackAdapter: Attempting TTS provider');

                    for await (const audio of this.trySynthesize(tts, text, connOptions)) {
                        // Track audio duration sent
                        const frameDurationMs =
                            (audio.frame.samplesPerChannel / audio.frame.sampleRate) * 1000;
                        audioDurationSent += frameDurationMs / 1000;

                        // Forward audio to queue
                        this.queue.put(audio);
                    }

                    // Success!
                    this._log.info(
                        { tts: tts.label, audioDurationSent: audioDurationSent.toFixed(2) },
                        'FallbackAdapter: TTS provider succeeded',
                    );
                    return;
                } catch (error) {
                    // Mark as unavailable if it was available before
                    if (status.available) {
                        status.available = false;
                        this.adapter._emitAvailabilityChanged(tts, false);
                    }

                    // Check if we sent significant audio before failing
                    if (audioDurationSent >= this.adapter.noFallbackAfterAudioDuration) {
                        this._log.error(
                            { tts: tts.label, audioDurationSent: audioDurationSent.toFixed(2) },
                            'TTS failed after sending significant audio, not retrying',
                        );
                        throw error;
                    }

                    if (audioDurationSent > 0) {
                        this._log.warn(
                            { tts: tts.label, audioDurationSent: audioDurationSent.toFixed(2) },
                            'TTS failed after sending some audio, retrying with next provider...',
                        );
                    }
                }
            }
        }

        // All TTS providers failed
        const duration = (Date.now() - startTime) / 1000;
        const labels = this.adapter.ttsProviders.map((t) => t.label).join(', ');
        throw new APIConnectionError({
            message: `all TTS providers failed (${labels}) after ${duration.toFixed(2)}s`,
        });
    }
}

/**
 * SynthesizeStream implementation for FallbackAdapter.
 * Handles fallback logic for streaming synthesis.
 */
class FallbackSynthesizeStream extends SynthesizeStream {
    label = 'tts.FallbackSynthesizeStream';

    private adapter: FallbackAdapter;
    private _log = log();
    private _currentStream?: SynthesizeStream;

    constructor(adapter: FallbackAdapter, connOptions: APIConnectOptions) {
        super(adapter, connOptions);
        this.adapter = adapter;
    }

    /**
     * Try to stream with a single TTS provider.
     * If the provider doesn't support streaming natively, wraps it with StreamAdapter.
     */
    private async *tryStream(
        tts: TTS,
        inputQueue: AsyncIterableQueue<string | typeof SynthesizeStream.FLUSH_SENTINEL>,
    ): AsyncGenerator<SynthesizedAudio | typeof SynthesizeStream.END_OF_STREAM, void, unknown> {
        const connOptions: APIConnectOptions = {
            maxRetry: this.adapter.maxRetryPerTts,
            timeoutMs: this.adapter.attemptTimeout * 1000,
            retryIntervalMs: this.adapter.retryInterval * 1000,
        };

        // Wrap non-streaming TTS with StreamAdapter if sentenceTokenizer is provided
        let actualTts: TTS = tts;
        if (!tts.capabilities.streaming && this.adapter.sentenceTokenizer) {
            this._log.debug(
                { tts: tts.label },
                'TTS does not support streaming, wrapping with StreamAdapter',
            );
            actualTts = new StreamAdapter(tts, this.adapter.sentenceTokenizer);
        }

        const stream = actualTts.stream({ connOptions });
        this._currentStream = stream;

        // Forward input to the underlying stream
        const forwardInput = async () => {
            try {
                for await (const item of inputQueue) {
                    if (item === SynthesizeStream.FLUSH_SENTINEL) {
                        stream.flush();
                    } else {
                        stream.pushText(item);
                    }
                }
                stream.endInput();
            } catch (error) {
                this._log.error({ error }, 'Error forwarding input to TTS stream');
                stream.close();
            }
        };

        // Start forwarding input in background
        forwardInput();

        try {
            for await (const audio of stream) {
                yield audio;
            }
        } catch (error) {
            if (error instanceof APIError) {
                this._log.warn({ tts: tts.label, error }, 'TTS stream failed, switching to next provider');
                throw error;
            }

            if (error instanceof Error && error.name === 'AbortError') {
                this._log.warn({ tts: tts.label }, 'TTS stream timed out, switching to next provider');
                throw error;
            }

            this._log.error(
                { tts: tts.label, error },
                'TTS stream unexpected error, switching to next provider',
            );
            throw error;
        } finally {
            stream.close();
        }
    }

    /**
     * Main run method - iterates through TTS providers with fallback logic.
     */
    protected async run(): Promise<void> {
        const startTime = Date.now();

        // Check if all TTS providers are unavailable
        const allFailed = this.adapter._status.every((s) => !s.available);
        if (allFailed) {
            this._log.error('all TTS providers are unavailable, retrying...');
        }

        // Buffer input so we can replay it to fallback providers
        const inputBuffer: (string | typeof SynthesizeStream.FLUSH_SENTINEL)[] = [];
        let inputEnded = false;

        // Consume and buffer input from this.input
        const bufferInput = async () => {
            for await (const item of this.input) {
                inputBuffer.push(item);
            }
            inputEnded = true;
        };

        // Start buffering input
        const bufferTask = bufferInput();

        for (let i = 0; i < this.adapter.ttsProviders.length; i++) {
            const tts = this.adapter.ttsProviders[i]!;
            const status = this.adapter._status[i]!;

            this._log.debug(
                { tts: tts.label, index: i, available: status.available, allFailed },
                'checking TTS provider',
            );

            if (status.available || allFailed) {
                let audioDurationSent = 0;

                // Create a new queue that replays buffered input and continues with new input
                const replayQueue = new AsyncIterableQueue<
                    string | typeof SynthesizeStream.FLUSH_SENTINEL
                >();

                // Replay buffered input and forward new input
                const replayAndForward = async () => {
                    // First, replay everything buffered so far
                    for (const item of inputBuffer) {
                        replayQueue.put(item);
                    }

                    // If input hasn't ended, continue forwarding new items
                    if (!inputEnded) {
                        // Wait for buffer task to complete while forwarding
                        let bufferIndex = inputBuffer.length;
                        while (!inputEnded) {
                            await new Promise((resolve) => setTimeout(resolve, 10));
                            // Forward any new items that were added to buffer
                            while (bufferIndex < inputBuffer.length) {
                                replayQueue.put(inputBuffer[bufferIndex]!);
                                bufferIndex++;
                            }
                        }
                        // Forward remaining items
                        while (bufferIndex < inputBuffer.length) {
                            replayQueue.put(inputBuffer[bufferIndex]!);
                            bufferIndex++;
                        }
                    }

                    replayQueue.close();
                };

                // Start replay in background
                replayAndForward();

                try {
                    this._log.info({ tts: tts.label }, 'FallbackAdapter: Attempting TTS provider');

                    for await (const audio of this.tryStream(tts, replayQueue)) {
                        if (audio === SynthesizeStream.END_OF_STREAM) {
                            this.queue.put(audio);
                            continue;
                        }

                        // Track audio duration sent
                        const frameDurationMs =
                            (audio.frame.samplesPerChannel / audio.frame.sampleRate) * 1000;
                        audioDurationSent += frameDurationMs / 1000;

                        // Forward audio to queue
                        this.queue.put(audio);
                    }

                    // Success! Wait for buffer task to complete
                    await bufferTask;

                    this._log.info(
                        { tts: tts.label, audioDurationSent: audioDurationSent.toFixed(2) },
                        'FallbackAdapter: TTS provider succeeded',
                    );
                    return;
                } catch (error) {
                    // Mark as unavailable if it was available before
                    if (status.available) {
                        status.available = false;
                        this.adapter._emitAvailabilityChanged(tts, false);
                    }

                    // Check if we sent significant audio before failing
                    if (audioDurationSent >= this.adapter.noFallbackAfterAudioDuration) {
                        this._log.error(
                            { tts: tts.label, audioDurationSent: audioDurationSent.toFixed(2) },
                            'TTS stream failed after sending significant audio, not retrying',
                        );
                        await bufferTask;
                        throw error;
                    }

                    if (audioDurationSent > 0) {
                        this._log.warn(
                            { tts: tts.label, audioDurationSent: audioDurationSent.toFixed(2) },
                            'TTS stream failed after sending some audio, retrying with next provider...',
                        );
                    }
                }
            }
        }

        // Wait for buffer task
        await bufferTask;

        // All TTS providers failed
        const duration = (Date.now() - startTime) / 1000;
        const labels = this.adapter.ttsProviders.map((t) => t.label).join(', ');
        throw new APIConnectionError({
            message: `all TTS providers failed (${labels}) after ${duration.toFixed(2)}s`,
        });
    }

    override close() {
        if (this._currentStream) {
            this._currentStream.close();
        }
        super.close();
    }
}
