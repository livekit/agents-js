// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { TTS, ChunkedStream, SynthesizeStream } from "./tts.js";

export interface FallbackTTSOptions {
    tts: TTS[];
    attemptTimeout?: number;
    maxRetryPerTTS?: number;
    retryInterval?: number;
    retryOnChunkSent?: boolean;
}

class FallbackAdapter extends TTS {
    label = 'tts.FallbackAdapter'

    constructor(opts: FallbackTTSOptions) {
        if (!opts.tts || opts.tts.length === 0) {
            throw new Error('FallbackAdapter requires at least one TTS provider');
        }
        const first = opts.tts[0];
        const streaming = opts.tts.some(p => p.capabilities.streaming);
        super(first.sampleRate, first.numChannels, { streaming });
    }

    synthesize(text: string): ChunkedStream {
        return new FallbackChunkedStreamthis, text);
    }

    stream(): SynthesizeStream {
        return new FallbackSynthesizeStream(this);
    }
}

class FallbackChunkedStream extends ChunkedStream {}
class FallbackSynthesizeStream extends SynthesizeStream {}