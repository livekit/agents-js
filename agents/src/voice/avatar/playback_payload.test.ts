// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { parsePlaybackFinishedPayload } from './playback_payload.js';

describe('parsePlaybackFinishedPayload', () => {
  it('parses the protocol-canonical snake_case payload (as emitted by Anam)', () => {
    // Captured verbatim from a live Anam avatar engine on interruption.
    const payload =
      '{"playback_position": 2.000000000000001, "interrupted": true, "synchronized_transcript": null}';
    const ev = parsePlaybackFinishedPayload(payload);
    expect(ev.playbackPosition).toBeCloseTo(2.0);
    expect(ev.interrupted).toBe(true);
    expect(ev.synchronizedTranscript).toBeUndefined();

    // The whole point of the fix: this must not become NaN -> JSON null.
    const audioEndMs = Math.floor(ev.playbackPosition * 1000);
    expect(Number.isFinite(audioEndMs)).toBe(true);
    expect(JSON.stringify({ audio_end_ms: audioEndMs })).toBe('{"audio_end_ms":2000}');
  });

  it('preserves a snake_case synchronized_transcript string', () => {
    const ev = parsePlaybackFinishedPayload(
      '{"playback_position": 1.5, "interrupted": false, "synchronized_transcript": "hello there"}',
    );
    expect(ev.playbackPosition).toBe(1.5);
    expect(ev.interrupted).toBe(false);
    expect(ev.synchronizedTranscript).toBe('hello there');
  });

  it('tolerates camelCase keys as a fallback for JS-side producers', () => {
    const ev = parsePlaybackFinishedPayload(
      '{"playbackPosition": 3.25, "interrupted": true, "synchronizedTranscript": "hi"}',
    );
    expect(ev.playbackPosition).toBe(3.25);
    expect(ev.interrupted).toBe(true);
    expect(ev.synchronizedTranscript).toBe('hi');
  });

  it('coerces a missing playback position to 0 (never NaN)', () => {
    const ev = parsePlaybackFinishedPayload('{"interrupted": true}');
    expect(ev.playbackPosition).toBe(0);
    expect(ev.interrupted).toBe(true);
    expect(ev.synchronizedTranscript).toBeUndefined();
    expect(Number.isFinite(Math.floor(ev.playbackPosition * 1000))).toBe(true);
  });

  it('coerces a null / non-numeric playback position to 0', () => {
    expect(parsePlaybackFinishedPayload('{"playback_position": null}').playbackPosition).toBe(0);
    expect(parsePlaybackFinishedPayload('{"playback_position": "1.5"}').playbackPosition).toBe(0);
  });

  it('keeps a legitimate zero position as 0', () => {
    const ev = parsePlaybackFinishedPayload('{"playback_position": 0, "interrupted": true}');
    expect(ev.playbackPosition).toBe(0);
  });

  it('defaults interrupted to false when absent', () => {
    expect(parsePlaybackFinishedPayload('{"playback_position": 1}').interrupted).toBe(false);
  });

  it('returns a safe default for a malformed / non-object payload (never throws or hangs)', () => {
    // "null" and "" would throw with a bare JSON.parse + property access; the others parse
    // to a non-object. All must yield the safe default so onPlaybackFinished still fires and
    // waitForPlayout() cannot hang the interrupted turn.
    for (const payload of ['null', '', '123', '"a string"', '[]', 'not json{']) {
      const ev = parsePlaybackFinishedPayload(payload);
      expect(ev.playbackPosition).toBe(0);
      expect(ev.interrupted).toBe(false);
      expect(ev.synchronizedTranscript).toBeUndefined();
    }
  });

  it('only treats a real boolean interrupted as authoritative (not a truthy "false" string)', () => {
    expect(
      parsePlaybackFinishedPayload('{"playback_position": 2, "interrupted": "false"}').interrupted,
    ).toBe(false);
    expect(
      parsePlaybackFinishedPayload('{"playback_position": 2, "interrupted": true}').interrupted,
    ).toBe(true);
  });
});
