import type { AudioFrame } from '@livekit/rtc-node';

/** AudioByteStream translates between LiveKit AudioFrame packets and raw byte data. */
export declare class AudioByteStream {
  private sampleRate;
  private numChannels;
  private bytesPerFrame;
  private buf;
  constructor(sampleRate: number, numChannels: number, samplesPerChannel?: number | null);
  write(data: ArrayBuffer): AudioFrame[];
  flush(): AudioFrame[];
}
//# sourceMappingURL=audio.d.ts.map
