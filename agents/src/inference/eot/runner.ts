// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Audio EOT inference runner — runs inside the shared `InferenceProcExecutor`
 * so the ~138 MB native model loads once per host instead of once per job
 * worker. Job-side transports reach it via `executor.doInference(...)`.
 *
 * The inference proc instantiates this with `new Runner()` (no args) and
 * calls `initialize()` once at startup, then dispatches `run(data)` per
 * request — see `ipc/inference_proc_lazy_main.ts`. Hence the default export
 * + no-arg constructor.
 */
import { InferenceRunner } from '../../inference_runner.js';
import { log } from '../../log.js';
import { _getLocalInferenceModule } from '../_warmup.js';

/** Inference method id used to register + dispatch the audio EOT runner. */
export const EOT_INFERENCE_METHOD = 'lk_eot_audio';

/** Request payload: base64-encoded 16 kHz s16le PCM (up to 1.2 s). */
export interface EotInferenceInput {
  pcm: string;
}

export interface EotInferenceOutput {
  probability: number;
  inferenceDurationMs: number;
}

export default class EotRunner extends InferenceRunner<EotInferenceInput, EotInferenceOutput> {
  #logger = log();
  #mod: ReturnType<typeof _getLocalInferenceModule>;

  async initialize(): Promise<void> {
    this.#mod = _getLocalInferenceModule();
    if (this.#mod === undefined) {
      // _getLocalInferenceModule() already emits a WARN when the binding
      // cannot be loaded (e.g. Bun on Windows does not fetch optional native
      // packages). Returning here — rather than throwing — keeps the inference
      // process alive so the agent falls back to VAD-only turn detection
      // instead of crashing with a FATAL (see #1900).
      return;
    }
    // Eagerly page in the EOT model singleton (~138 MB) so the first
    // request doesn't pay the load on the hot path.
    this.#mod.initEot();
  }

  async run(data: EotInferenceInput): Promise<EotInferenceOutput> {
    if (this.#mod === undefined) {
      // Native binding unavailable — return a zero probability so callers
      // treat every frame as "not end-of-turn" and VAD remains the sole
      // turn-detection mechanism.
      return { probability: 0, inferenceDurationMs: 0 };
    }
    // base64 → bytes → Int16Array view (PCM is 16 kHz s16le)
    const bytes = Buffer.from(data.pcm, 'base64');
    const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
    const t0 = performance.now();
    let probability = 0.0;
    try {
      probability = await this.#mod.predict(pcm);
    } catch (err) {
      this.#logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        'local audio EOT prediction failed',
      );
    }
    return { probability, inferenceDurationMs: performance.now() - t0 };
  }

  async close(): Promise<void> {
    return;
  }
}
