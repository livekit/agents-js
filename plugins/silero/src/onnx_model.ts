// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { fileURLToPath } from 'node:url';
import { InferenceSession, Tensor } from 'onnxruntime-node';

export type SampleRate = 8000 | 16000;

export const newInferenceSession = (forceCPU: boolean) => {
  return InferenceSession.create(fileURLToPath(new URL('silero_vad.onnx', import.meta.url).href), {
    interOpNumThreads: 1,
    intraOpNumThreads: 1,
    executionMode: 'sequential',
    executionProviders: forceCPU ? [{ name: 'cpu' }] : undefined,
  });
};

export class OnnxModel {
  #session: InferenceSession;
  #sampleRate: number;
  #windowSizeSamples: number;
  #contextSize: number;
  #sampleRateNd: BigInt64Array;
  #context: Float32Array;
  // #state: Float32Array;
  #rnnState: Float32Array;
  #inputBuffer: Float32Array;

  constructor(session: InferenceSession, sampleRate: SampleRate) {
    this.#session = session;
    this.#sampleRate = sampleRate;

    switch (sampleRate) {
      case 8000:
        this.#windowSizeSamples = 256;
        this.#contextSize = 32;
        break;
      case 16000:
        this.#windowSizeSamples = 512;
        this.#contextSize = 64;
        break;
    }

    this.#sampleRateNd = BigInt64Array.from([BigInt(sampleRate)]);
    this.#context = new Float32Array(this.#contextSize);
    this.#rnnState = new Float32Array(2 * 1 * 128);
    this.#inputBuffer = new Float32Array(this.#contextSize + this.#windowSizeSamples);
  }

  get sampleRate(): number {
    return this.#sampleRate;
  }

  get windowSizeSamples(): number {
    return this.#windowSizeSamples;
  }

  get contextSize(): number {
    return this.#contextSize;
  }

  async run(x: Float32Array): Promise<number> {
    this.#inputBuffer.set(this.#context, 0);
    this.#inputBuffer.set(x, this.#contextSize);

    return await this.#session
      .run({
        input: new Tensor('float32', this.#inputBuffer, [
          1,
          this.#contextSize + this.#windowSizeSamples,
        ]),
        state: new Tensor('float32', this.#rnnState, [2, 1, 128]),
        sr: new Tensor('int64', this.#sampleRateNd),
      })
      .then((result) => {
        // this.#state = result.output.data as Float32Array,
        this.#context = this.#inputBuffer.subarray(0, this.#contextSize);
        return (result.output!.data as Float32Array).at(0)!;
      });
  }
}
