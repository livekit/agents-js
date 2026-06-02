// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioFrame } from '@livekit/rtc-node';

const SAMPLE_RATE = 48000;
const BLOCK = 4800;

const ROOT_HZ = 174.61; // F3
const CHORD_SEMITONES = [0, 4, 7];

const BEAT = 280;
const NOTE_DUR = 340;
const TAG_DELAY = 80;
const TAG_DUR = 180;
const TAG_AMP = 0.45;
const TAIL = 850;

const ATTACK_FRAC = 0.55;
const RELEASE_FRAC = 0.1;

const WOBBLE_HZ = 22.0;
const WOBBLE_DEPTH = 0.05;
const DETUNE_CENTS = 2.0;

const AMP = 2500.0;

let holdLoop: Int16Array | undefined;

function sampleCount(duration: number): number {
  return Math.floor((duration * SAMPLE_RATE) / 1000);
}

function asrEnvelope(n: number): Float64Array {
  const env = new Float64Array(n);
  if (n <= 1) {
    return env;
  }

  const attackN = Math.max(1, Math.floor(n * ATTACK_FRAC));
  const releaseN = Math.max(1, Math.floor(n * RELEASE_FRAC));
  const sustainN = Math.max(0, n - attackN - releaseN);

  for (let i = 0; i < attackN; i++) {
    env[i] = i / Math.max(1, attackN - 1);
  }
  for (let i = attackN; i < attackN + sustainN; i++) {
    env[i] = 1.0;
  }
  for (let i = 0; i < releaseN; i++) {
    env[attackN + sustainN + i] = 1.0 - i / Math.max(1, releaseN - 1);
  }

  if (WOBBLE_DEPTH > 0) {
    for (let i = 0; i < n; i++) {
      const t = i / SAMPLE_RATE;
      env[i]! *=
        1.0 - WOBBLE_DEPTH + WOBBLE_DEPTH * (0.5 + 0.5 * Math.cos(2 * Math.PI * WOBBLE_HZ * t));
    }
  }

  return env;
}

function note(freq: number, duration: number, amp: number): Float64Array {
  const n = sampleCount(duration);
  const env = asrEnvelope(n);
  const out = new Float64Array(n);
  const det = 2.0 ** (DETUNE_CENTS / 1200.0);

  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    let voice = 0.5 * Math.sin(2 * Math.PI * freq * det * t);
    voice += 0.5 * Math.sin((2 * Math.PI * freq * t) / det);
    out[i] = voice * env[i]! * amp;
  }

  return out;
}

function semitoneFreq(rootHz: number, semis: number): number {
  return rootHz * 2.0 ** (semis / 12.0);
}

function buildHoldLoop(): Int16Array {
  const chordNotes = CHORD_SEMITONES.map((s) => semitoneFreq(ROOT_HZ, s));
  const tagFreq = chordNotes[chordNotes.length - 1]!;
  const tagOnset = chordNotes.length * BEAT + TAG_DELAY;
  const totalN = sampleCount(tagOnset + TAG_DUR + TAIL);
  const out = new Float64Array(totalN);

  for (const [i, freq] of chordNotes.entries()) {
    const noteData = note(freq, NOTE_DUR, AMP);
    const start = sampleCount(i * BEAT);
    const end = Math.min(totalN, start + noteData.length);
    for (let j = start; j < end; j++) {
      out[j]! += noteData[j - start]!;
    }
  }

  const tag = note(tagFreq, TAG_DUR, AMP * TAG_AMP);
  const start = sampleCount(tagOnset);
  const end = Math.min(totalN, start + tag.length);
  for (let j = start; j < end; j++) {
    out[j]! += tag[j - start]!;
  }

  const clipped = new Int16Array(totalN);
  for (let i = 0; i < totalN; i++) {
    clipped[i] = Math.max(-32767, Math.min(32767, Math.round(out[i]!)));
  }
  return clipped;
}

function getHoldLoop(): Int16Array {
  holdLoop ??= buildHoldLoop();
  return holdLoop;
}

export async function* holdBeats(): AsyncGenerator<AudioFrame> {
  const loop = getHoldLoop();
  let t = 0;

  while (true) {
    const chunk = new Int16Array(BLOCK);
    for (let i = 0; i < BLOCK; i++) {
      chunk[i] = loop[(t + i) % loop.length]!;
    }
    t += BLOCK;
    yield new AudioFrame(chunk, SAMPLE_RATE, 1, BLOCK);
  }
}
