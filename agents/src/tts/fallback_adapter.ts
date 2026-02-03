// SPDX-FileCopyrightText: 2024 LiveKit, Inc.  
//  
// SPDX-License-Identifier: Apache-2.0 
import { AudioResampler } from '@livekit/rtc-node';
import { APIConnectionError, APIError } from '../_exceptions.js';
import { TTS, type TTSCapabilities, ChunkedStream, SynthesizeStream } from './tts.js';
import { log } from '../log.js';
import { DEFAULT_API_CONNECT_OPTIONS, type APIConnectOptions } from '../types.js';
import { Task } from '../utils.js';

interface TTSStatus {
    available: boolean;
    recoveringTask: Task<void> | null;
    resampler: AudioResampler | null;
}
interface FallbackAdapterOptions {
    ttsInstances: TTS[];
    maxRetryPerTTs?: number;
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
        this.maxRetryPerTTS = opts.maxRetryPerTTs ?? 3;

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

    }

}
