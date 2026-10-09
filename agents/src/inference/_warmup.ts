// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Loader for the bundled `@livekit/local-inference` native binding.
 *
 * Memory model (measured ~138 MB for the EOT model, ~2 MB for VAD): Node has
 * no forkserver/COW, so anything loaded in a job worker is private to that
 * worker. To avoid paying ~138 MB per worker, the EOT model is NOT loaded in
 * job workers — it runs in the shared `InferenceProcExecutor` (see
 * `inference/eot/runner.ts`), loaded once per host. The VAD stays in-process
 * (it's small and runs continuously) and is reached via this loader.
 *
 * There are intentionally no public `prewarm*` helpers: EOT auto-warms via
 * the inference runner's `initialize()` at proc startup, and the VAD lazy-
 * loads on first stream. `LIVEKIT_AGENTS_PRELOAD_LOCAL_INFERENCE=0` defers
 * both native binding loads and the EOT warm-up until first use.
 */
import { createRequire } from 'node:module';
import { log } from '../log.js';

const cjsRequire = createRequire(import.meta.url);

export const ENV_PRELOAD_LOCAL_INFERENCE = 'LIVEKIT_AGENTS_PRELOAD_LOCAL_INFERENCE';

const FALSY_ENV_VALUES = new Set(['0', 'false', 'no', 'off']);

/** @internal Whether local inference should be loaded ahead of its first use. */
export function _shouldPreloadLocalInference(): boolean {
  const value = process.env[ENV_PRELOAD_LOCAL_INFERENCE];
  return value === undefined || !FALSY_ENV_VALUES.has(value.trim().toLowerCase());
}

let nativeMod: typeof import('@livekit/local-inference') | undefined;
let triedLoad = false;

function getNative(): typeof import('@livekit/local-inference') | undefined {
  if (triedLoad) return nativeMod;
  triedLoad = true;
  try {
    nativeMod = cjsRequire('@livekit/local-inference') as typeof import('@livekit/local-inference');
    return nativeMod;
  } catch (err) {
    log().warn(
      { err: err instanceof Error ? err.message : String(err) },
      '@livekit/local-inference native binding not loadable; local VAD/EOT paths disabled',
    );
    return undefined;
  }
}

/** @internal Returns the loaded native module, or `undefined` if unavailable. */
export function _getLocalInferenceModule(): typeof import('@livekit/local-inference') | undefined {
  return getNative();
}
