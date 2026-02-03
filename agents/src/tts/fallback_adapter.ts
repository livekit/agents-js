// SPDX-FileCopyrightText: 2024 LiveKit, Inc.  
//  
// SPDX-License-Identifier: Apache-2.0 
import type { AudioResampler } from '@livekit/rtc-node';
import { TTS } from './tts.js';
import { log } from '../log.js';

interface TTSStatus {
    available: boolean;
    recoveringTask: Promise<void> | null;
    resampler: AudioResampler | null;
}

class FallbackAdapter extends TTS {
    readonly ttsInstances: TTS[];
    readonly maxRetryPerTTs: number;

    private _status: TTSStatus[] = [];
    private _logger = log();

    label: string = `tts.FallbackAdapter`;

}