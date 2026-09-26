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

// tests hand the session duck-typed TTS objects that lack the base-class getter
function wrappedTts(tts: TTS): readonly TTS[] {
  return tts._wrappedTts ?? [];
}

/** @internal Counts the instance and, through an adapter, each provider it wraps. */
export function retainTts(tts: TTS | undefined): void {
  if (!tts) return;
  users.set(tts, (users.get(tts) ?? 0) + 1);
  for (const wrapped of wrappedTts(tts)) retainTts(wrapped);
}

/** @internal Never throws: a failed release is worth a warning, not a failed teardown. */
export async function releaseTts(tts: TTS | undefined): Promise<void> {
  if (!tts) return;
  for (const wrapped of wrappedTts(tts)) await releaseTts(wrapped);
  const remaining = (users.get(tts) ?? 1) - 1;
  if (remaining > 0) {
    users.set(tts, remaining);
    return;
  }
  users.delete(tts);
  // an adapter holds no connections of its own; its providers were released above by count
  if (wrappedTts(tts).length > 0) return;
  try {
    await tts.releaseIdleConnections();
  } catch (error) {
    log().warn({ error, tts: tts.label }, 'failed to release TTS connections');
  }
}
