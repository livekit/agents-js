// SPDX-FileCopyrightText: 2024 LiveKit, Inc.  
//  
// SPDX-License-Identifier: Apache-2.0 
import type { AudioResampler } from '@livekit/rtc-node';
import { TTS, type TTSCapabilities } from './tts.js';
import { log } from '../log.js';
import { options } from 'marked';

interface TTSStatus {
    available: boolean;
    recoveringTask: Promise<void> | null;
    resampler: AudioResampler | null;
}

interface FallbackAdapterOptions {
    ttsInstances: TTS[];
    maxRetryPerTTs?: number;
}

class FallbackAdapter extends TTS {
    readonly ttsInstances: TTS[];
    readonly maxRetryPerTTs: number;

    private _status: TTSStatus[] = [];
    private _logger = log();

    label: string = `tts.FallbackAdapter`;

    constructor(opts: FallbackAdapterOptions) {
        if (!opts.ttsInstances || opts.ttsInstances.length < 1) {
            throw new Error('at least one TTS instance must be provided.');
        }
        const numChannels = opts.ttsInstances[0]?.numChannels
        const allNumChannelsMatch = opts.ttsInstances.every((tts) => tts.numChannels === numChannels);
        if (!allNumChannelsMatch) {
            throw new Error("All TTS instances should have the same number of channels");
        }
        const sampleRate = Math.max(...opts.ttsInstances.map(t => t.sampleRate));



    }
    private static aggregateCapabilities(instances: TTS[]): TTSCapabilities {
        const streaming = instances.some(tts => tts.capabilities.streaming);
        const alignedTranscript = instances.every(tts => tts.capabilities.alignedTranscript === true);
        return { streaming, alignedTranscript };
    }



}