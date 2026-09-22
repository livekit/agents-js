// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { PlaybackFinishedEvent } from '../io.js';

/**
 * Parse a raw `lk.playback_finished` RPC payload into a {@link PlaybackFinishedEvent}.
 *
 * The LiveKit avatar DataStream protocol serializes this payload with **snake_case**
 * keys (`playback_position`, `synchronized_transcript`) — matching the canonical Python
 * `AvatarRunner`, which sends `json.dumps(asdict(PlaybackFinishedEvent(...)))` over a
 * dataclass whose fields are `playback_position` / `interrupted` / `synchronized_transcript`.
 * This was confirmed empirically against Anam's live avatar engine, which emits e.g.
 * `{"playback_position": 2.0, "interrupted": true, "synchronized_transcript": null}`.
 *
 * A bare `JSON.parse(payload) as PlaybackFinishedEvent` cast does no runtime key
 * remapping, so the camelCase `playbackPosition` field read back `undefined`. Downstream
 * that became `Math.floor(undefined * 1000) === NaN`, which `JSON.stringify` serializes as
 * `null` inside `conversation.item.truncate`; the OpenAI Realtime API then rejects the
 * truncate with an `invalid_type` error, leaving the interrupted turn desynced and the
 * conversation stalled.
 *
 * We accept snake_case as the primary (protocol-canonical) form and tolerate camelCase as
 * a fallback for any JS-side producer. A missing/`null`/non-finite position is coerced to
 * `0`, and a malformed or non-object payload yields a safe default event (position `0`, not
 * interrupted) rather than throwing — so a bad payload can neither propagate a non-finite
 * position nor escape the RPC handler and hang the unguarded `waitForPlayout()`.
 */
export function parsePlaybackFinishedPayload(payload: string): PlaybackFinishedEvent {
  // Never throw out of the RPC handler: a throw would skip onPlaybackFinished and hang the
  // unguarded waitForPlayout() on the interrupted turn. Coerce anything that is not a JSON
  // object into an empty object and fall through to the field defaults below.
  let raw: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(payload);
    if (typeof parsed === 'object' && parsed !== null) {
      raw = parsed as Record<string, unknown>;
    }
  } catch {
    // malformed JSON; keep the empty default
  }

  const rawPosition = raw.playback_position ?? raw.playbackPosition;
  const playbackPosition =
    typeof rawPosition === 'number' && Number.isFinite(rawPosition) ? rawPosition : 0;

  const rawTranscript = raw.synchronized_transcript ?? raw.synchronizedTranscript;
  const synchronizedTranscript = typeof rawTranscript === 'string' ? rawTranscript : undefined;

  // Only a real JSON boolean is authoritative; never coerce a truthy string like "false".
  const interrupted = typeof raw.interrupted === 'boolean' ? raw.interrupted : false;

  return {
    playbackPosition,
    interrupted,
    synchronizedTranscript,
  };
}
