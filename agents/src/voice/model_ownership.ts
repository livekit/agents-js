// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { log } from '../log.js';
import type { TTS } from '../tts/tts.js';

/**
 * Models the framework constructed itself, from a model string passed to `Agent`, `AgentTask`
 * or `AgentSession`. Nothing else holds a reference to such an instance, so the framework may
 * release its provider connections when it is done with it. An instance the user constructed is
 * theirs: the framework never releases or closes it.
 */
const frameworkOwned = new WeakSet<object>();

/** @internal */
export function markFrameworkOwned<T extends object>(model: T): T {
  frameworkOwned.add(model);
  return model;
}

/** @internal */
export function isFrameworkOwned(model: object): boolean {
  return frameworkOwned.has(model);
}

/**
 * Drop the idle pooled connections of a framework-owned TTS the framework is done with; a
 * user-constructed instance is left alone. Idle-only, so an in-flight synthesis is unaffected.
 * Never throws: a failed release is worth a warning, not a failed teardown.
 *
 * @internal
 */
export async function releaseIfFrameworkOwned(tts: TTS | null | undefined): Promise<void> {
  if (!tts || !isFrameworkOwned(tts)) return;
  try {
    await tts.releaseIdleConnections();
  } catch (error) {
    log().warn({ error, tts: tts.label }, 'failed to release TTS connections');
  }
}
