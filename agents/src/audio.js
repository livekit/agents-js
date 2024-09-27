// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioFrame } from '@livekit/rtc-node';
import { log } from './log.js';
/** AudioByteStream translates between LiveKit AudioFrame packets and raw byte data. */
export class AudioByteStream {
    constructor(sampleRate, numChannels, samplesPerChannel = null) {
        this.sampleRate = sampleRate;
        this.numChannels = numChannels;
        if (samplesPerChannel === null) {
            samplesPerChannel = Math.floor(sampleRate / 50); // 20ms by default
        }
        this.bytesPerFrame = numChannels * samplesPerChannel * 2; // 2 bytes per sample (Int16)
        this.buf = new Int8Array();
    }
    write(data) {
        this.buf = new Int8Array([...this.buf, ...new Int8Array(data)]);
        const frames = [];
        while (this.buf.length >= this.bytesPerFrame) {
            const frameData = this.buf.slice(0, this.bytesPerFrame);
            this.buf = this.buf.slice(this.bytesPerFrame);
            frames.push(new AudioFrame(new Int16Array(frameData.buffer), this.sampleRate, this.numChannels, frameData.length / 2));
        }
        return frames;
    }
    flush() {
        if (this.buf.length % (2 * this.numChannels) !== 0) {
            log().warn('AudioByteStream: incomplete frame during flush, dropping');
            return [];
        }
        return [
            new AudioFrame(new Int16Array(this.buf.buffer), this.sampleRate, this.numChannels, this.buf.length / 2),
        ];
    }
}
//# sourceMappingURL=audio.js.map