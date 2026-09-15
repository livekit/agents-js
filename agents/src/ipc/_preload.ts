// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * The framework's own one-time warm-up, run in the job process before the user prewarm.
 *
 * Each step is lazy one-time work that would otherwise run inside the first job, on the event
 * loop, as a stall at session start that no user code caused. Node has no forkserver, so unlike
 * the Python `ipc._preload` module this cannot run once per worker and be inherited
 * copy-on-write: every job process pays it, but before any job is assigned.
 *
 * Failures are logged at debug level only: the first real use reports a proper error.
 */
import { _getLocalInferenceModule } from '../inference/_warmup.js';
import { log } from '../log.js';

function step(name: string, fn: () => unknown): void {
  const started = performance.now();
  try {
    fn();
  } catch (error) {
    log().debug({ error }, `could not preload ${name}`);
    return;
  }
  log().debug({ elapsed: Math.round(performance.now() - started) }, `preloaded ${name}`);
}

/** Run every warm-up step. Idempotent: the loaders it calls cache their result. */
export function preload(): void {
  // the local inference native binding (the VAD runs in-process; the EOT model lives in the
  // shared inference process, see inference/_warmup.ts)
  step('the local inference binding', () => _getLocalInferenceModule());
  // the livekit-rtc native binding is loaded when @livekit/rtc-node is imported, which the
  // job process does at startup; its runtime (FfiClient) starts with the first Room and the
  // SDK exposes no way to start it earlier
}
