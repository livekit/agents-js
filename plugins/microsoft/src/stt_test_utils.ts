// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { VAD, type VADEvent, VADEventType, VADStream } from '@livekit/agents';
import { AudioFrame } from '@livekit/rtc-node';

/** Deterministic VAD used by the Microsoft STT wire-protocol tests. */
export class ScriptedVAD extends VAD {
  readonly boundaries: Map<number, VADEventType>;
  readonly prefixSamples: number;
  readonly streams: ScriptedVADStream[] = [];
  label = 'microsoft.ScriptedVAD';

  constructor(boundaries: Record<number, VADEventType> = {}, prefixSamples = 16_000) {
    super({ updateInterval: 32 });
    this.boundaries = new Map(
      Object.entries(boundaries).map(([sample, type]) => [Number(sample), type]),
    );
    this.prefixSamples = prefixSamples;
  }

  override stream(): ScriptedVADStream {
    const stream = new ScriptedVADStream(this);
    this.streams.push(stream);
    return stream;
  }
}

export class ScriptedVADStream extends VADStream {
  readonly #detector: ScriptedVAD;
  #pending = Buffer.alloc(0);
  #prefix = Buffer.alloc(0);
  #samples = 0;
  #outputEnded = false;

  constructor(detector: ScriptedVAD) {
    super(detector);
    this.#detector = detector;
  }

  override pushFrame(frame: AudioFrame): void {
    if (this.inputClosed) throw new Error('Input is closed');
    if (this.closed) throw new Error('Stream is closed');
    this.#pending = Buffer.concat([
      this.#pending,
      Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength),
    ]);
    while (this.#pending.length >= 1024) {
      this.#prefix = Buffer.concat([this.#prefix, this.#pending.subarray(0, 1024)]);
      this.#pending = this.#pending.subarray(1024);
      const excess = this.#prefix.length - this.#detector.prefixSamples * 2;
      if (excess > 0) this.#prefix = this.#prefix.subarray(excess);
      this.#samples += 512;
      this.sendVADEvent(this.#event(VADEventType.INFERENCE_DONE));
      const boundary = this.#detector.boundaries.get(this.#samples);
      if (boundary !== undefined) this.sendVADEvent(this.#event(boundary));
    }
  }

  override endInput(): void {
    if (this.inputClosed) throw new Error('Input is closed');
    this.inputClosed = true;
    this.#outputEnded = true;
    void this.outputWriter.close();
  }

  override close(): void {
    if (this.closed) return;
    if (!this.#outputEnded) {
      super.close();
      return;
    }
    this.outputWriter.releaseLock();
    void this.outputReader.cancel();
    this.closed = true;
  }

  #event(type: VADEventType): VADEvent {
    const frames =
      type === VADEventType.START_OF_SPEECH && this.#prefix.length > 0
        ? [
            new AudioFrame(
              new Int16Array(
                this.#prefix.buffer.slice(
                  this.#prefix.byteOffset,
                  this.#prefix.byteOffset + this.#prefix.byteLength,
                ),
              ),
              16_000,
              1,
              this.#prefix.length / 2,
            ),
          ]
        : [];
    return {
      type,
      samplesIndex: this.#samples,
      timestamp: (this.#samples / 16_000) * 1000,
      speechDuration: (this.#samples / 16_000) * 1000,
      silenceDuration: 0,
      frames,
      probability: type === VADEventType.START_OF_SPEECH ? 1 : 0,
      inferenceDuration: 0,
      speaking: type === VADEventType.START_OF_SPEECH,
      rawAccumulatedSilence: 0,
      rawAccumulatedSpeech: 0,
    };
  }
}
