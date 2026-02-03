// SPDX-FileCopyrightText: 2024 LiveKit, Inc.  
//  
// SPDX-License-Identifier: Apache-2.0 
import { AudioResampler } from '@livekit/rtc-node';
import { APIConnectionError, APIError } from '../_exceptions.js';
import { TTS, type TTSCapabilities, ChunkedStream, SynthesizeStream } from './tts.js';
import { log } from '../log.js';
import { DEFAULT_API_CONNECT_OPTIONS, type APIConnectOptions } from '../types.js';
import { Task, cancelAndWait } from '../utils.js';
import { basic } from '../tokenize/index.js';
import { StreamAdapter } from './stream_adapter.js';


interface TTSStatus {
    available: boolean;
    recoveringTask: Task<void> | null;
    resampler: AudioResampler | null;
}
interface FallbackAdapterOptions {
    ttsInstances: TTS[];
    maxRetryPerTTS?: number;
}

export interface AvailabilityChangedEvent {
    tts: TTS;
    available: boolean;
}

const DEFAULT_FALLBACK_API_CONNECT_OPTIONS: APIConnectOptions = {
    maxRetry: 0,
    timeoutMs: DEFAULT_API_CONNECT_OPTIONS.timeoutMs,
    retryIntervalMs: DEFAULT_API_CONNECT_OPTIONS.retryIntervalMs,
};


class FallbackAdapter extends TTS {
    readonly ttsInstances: TTS[];
    readonly maxRetryPerTTS: number;

    private _status: TTSStatus[] = [];
    private _logger = log();

    label: string = `tts.FallbackAdapter`;

    constructor(opts: FallbackAdapterOptions) {
        if (!opts.ttsInstances || opts.ttsInstances.length < 1) {
            throw new Error('at least one TTS instance must be provided.');
        }
        const numChannels = opts.ttsInstances[0]!.numChannels
        const allNumChannelsMatch = opts.ttsInstances.every((tts) => tts.numChannels === numChannels);
        if (!allNumChannelsMatch) {
            throw new Error("All TTS instances should have the same number of channels");
        }
        const sampleRate = Math.max(...opts.ttsInstances.map(t => t.sampleRate));
        const capabilities = FallbackAdapter.aggregateCapabilities(opts.ttsInstances);
        super(sampleRate, numChannels, capabilities);
        this.ttsInstances = opts.ttsInstances;
        this.maxRetryPerTTS = opts.maxRetryPerTTS ?? 3;

        // Initialize status for each TTS instance. If a TTS has a lower sample rate than
        // the adapter's output rate, create a resampler to upsample its audio output.
        // This ensures consistent audio format regardless of which TTS is active.
        this._status = this.ttsInstances.map((tts) => {
            let resampler: AudioResampler | null = null;
            if (sampleRate !== tts.sampleRate) {
                this._logger.info(`resampling ${tts.label} from ${tts.sampleRate}Hz to ${sampleRate}Hz`);
                resampler = new AudioResampler(tts.sampleRate, sampleRate, tts.numChannels);
            }
            return {
                available: true,
                recoveringTask: null,
                resampler: resampler,
            }
        });
        this.setupEventForwarding();
    }
    private static aggregateCapabilities(instances: TTS[]): TTSCapabilities {
        const streaming = instances.some(tts => tts.capabilities.streaming);
        const alignedTranscript = instances.every(tts => tts.capabilities.alignedTranscript === true);
        return { streaming, alignedTranscript };
    }

    private setupEventForwarding(): void {
        this.ttsInstances.forEach(tts => {
            tts.on('metrics_collected', (metrics) => {
                this.emit('metrics_collected', metrics);
            });
            tts.on('error', (error) => {
                this.emit('error', error);
            });
        });
    }

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
        status.recoveringTask = Task.from(async () => {
            try {
                const testStream = tts.synthesize('Hello world, this is a recovery test.', {
                    maxRetry: 0,
                    timeoutMs: 10000,
                    retryIntervalMs: 2000,
                });

                for await (const _ of testStream) {
                    // Just consume the stream to test connectivity  
                }
                status.available = true;
                status.recoveringTask = null;
                this._logger.info({ tts: tts.label }, 'TTS recovered');
                this.emitAvailabilityChanged(tts, true);
            } catch (error) {
                this._logger.debug({ tts: tts.label, error }, 'TTS recovery failed, will retry');
                status.recoveringTask = null;
                // Retry recovery after delay (matches Python's retry behavior)  
                setTimeout(() => this.tryRecovery(index), 5000);
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

    stream(options?: { connOptions?: APIConnectOptions }): SynthesizeStream {
        return new FallbackSynthesizeStream(
            this,
            options?.connOptions ?? DEFAULT_FALLBACK_API_CONNECT_OPTIONS,
        );
    }

    async close(): Promise<void> {
        // Cancel all recovery tasks  
        const recoveryTasks = this._status
            .map(s => s.recoveringTask)
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
        await Promise.all(this.ttsInstances.map(tts => tts.close()));
    }




}

class FallbackChunkedStream extends ChunkedStream {
    private adapter: FallbackAdapter;
    private connOptions: APIConnectOptions;
    private _logger = log();

    label: string = 'tts.FallbackChunkedStream';

    constructor(adapter: FallbackAdapter, text: string, connOptions: APIConnectOptions, abortSignal?: AbortSignal) {
        super(text, adapter, connOptions, abortSignal);
        this.adapter = adapter;
        this.connOptions = connOptions;
    }

    protected async run(): Promise<void> {
        const allTTSFailed = this.adapter.status.every((s) => !s.available);
        let lastRequestId: string = '';
        let lastSegmentId: string = '';
        if (allTTSFailed) {
            this._logger.warn('All fallback TTS instances failed, retrying From First...');
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
                for await (const audio of stream) {
                    if (this.abortController.signal.aborted) {
                        stream.close();
                        return;
                    }

                    // Use cached resampler for this TTS instance  
                    const resampler = status.resampler;
                    if (resampler) {
                        for (const frame of resampler.push(audio.frame)) {
                            this.queue.put({
                                ...audio,
                                frame,
                            });
                        }
                    } else {
                        this.queue.put(audio);
                    }
                    lastRequestId = audio.requestId;
                    lastSegmentId = audio.segmentId;
                }

                // Flush any remaining resampled frames  
                if (status.resampler) {
                    for (const frame of status.resampler.flush()) {
                        this.queue.put({
                            requestId: lastRequestId || '',
                            segmentId: lastSegmentId || '',
                            frame,
                            final: true,
                        });
                    }
                }

                this._logger.debug({ tts: tts.label }, 'TTS synthesis succeeded');
                return;
            }
            catch (error) {
                if (error instanceof APIError || error instanceof APIConnectionError) {
                    this._logger.warn({ tts: tts.label, error }, 'TTS failed, switching to next instance');
                    this.adapter.markUnAvailable(i);
                } else {
                    throw error;
                }
            }
        }
        const labels = this.adapter.ttsInstances.map(t => t.label).join(', ');
        throw new APIConnectionError({
            message: `all TTS instances failed (${labels})`,
        });

    }

}

class FallbackSynthesizeStream extends SynthesizeStream {
    private adapter: FallbackAdapter;
    private tokenBuffer: string[] = [];
    private audioPushed = false;
    private _logger = log();

    label: string = 'tts.FallbackSynthesizeStream';

    constructor(adapter: FallbackAdapter, connOptions: APIConnectOptions) {
        super(adapter, connOptions);
        this.adapter = adapter;
    }

    protected async run(): Promise<void> {
        const allTTSFailed = this.adapter.status.every(s => !s.available);
        if (allTTSFailed) {
            this._logger.warn('All fallback TTS instances failed, retrying From First...');
        }
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

                // Push buffered tokens to new stream  
                for (const token of this.tokenBuffer) {
                    stream.pushText(token);
                }

                const forwardInput = async () => {
                    for await (const input of this.input) {
                        if (this.abortController.signal.aborted) break;

                        if (input === SynthesizeStream.FLUSH_SENTINEL) {
                            stream.flush();
                        } else {
                            this.tokenBuffer.push(input);
                            stream.pushText(input);
                        }
                    }
                    stream.endInput();
                };

                const processOutput = async () => {
                    for await (const audio of stream) {
                        if (this.abortController.signal.aborted) {
                            stream.close();
                            return;
                        }

                        if (audio === SynthesizeStream.END_OF_STREAM) {
                            this.queue.put(audio);
                            continue;
                        }

                        // Use cached resampler for this TTS instance  
                        const resampler = status.resampler;
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
                    if (status.resampler) {
                        for (const frame of status.resampler.flush()) {
                            this.queue.put({
                                requestId: lastRequestId || '',
                                segmentId: lastSegmentId || '',
                                frame,
                                final: true,
                            });
                        }
                    }
                };

                await Promise.all([forwardInput(), processOutput()]);

                this._logger.debug({ tts: originalTts.label }, 'TTS stream succeeded');
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
                    this._logger.warn({ tts: originalTts.label, error }, 'TTS failed, switching to next instance');
                    this.adapter.markUnAvailable(i);
                } else {
                    throw error;
                }
            }
        }

        const labels = this.adapter.ttsInstances.map(t => t.label).join(', ');
        throw new APIConnectionError({
            message: `all TTS instances failed (${labels})`,
        });
    }
}