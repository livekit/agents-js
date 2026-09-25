// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { log } from '../log.js';
import type { TTS } from '../tts/tts.js';

/**
 * How many activities and sessions currently use each TTS instance. The last one to let go
 * releases the instance's pooled connections, which would otherwise idle until the process
 * exits. Counting users instead of guessing an owner makes sharing safe by construction: an
 * instance passed to two agents, or to several sessions in one process, keeps its connections
 * until the last of them is done. A user-held instance stays usable and reconnects on its next
 * synthesis.
 */
const users = new WeakMap<TTS, number>();

/** @internal */
export function retainTts(tts: TTS | undefined): void {
  if (tts) users.set(tts, (users.get(tts) ?? 0) + 1);
}

/** @internal Never throws: a failed release is worth a warning, not a failed teardown. */
export async function releaseTts(tts: TTS | undefined): Promise<void> {
  if (!tts) return;
  const remaining = (users.get(tts) ?? 1) - 1;
  if (remaining > 0) {
    users.set(tts, remaining);
    return;
  }
  users.delete(tts);
  try {
    await tts.releaseIdleConnections();
  } catch (error) {
    log().warn({ error, tts: tts.label }, 'failed to release TTS connections');
  }
}
