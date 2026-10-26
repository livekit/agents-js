// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Normalize a free-form delivery label into a small, fixed set of moods.
 *
 * The label space is open-ended: Fish Audio emits single words from a closed set, Inworld
 * emits free-form English ("soft, with genuine care"), and models drift outside whichever
 * set they were given. Matching here is best-effort, and happens agent-side so no client
 * SDK needs its own copy of the keyword table.
 */
import { MOOD_KEYWORDS } from './mood_data.js';

export type AgentMood =
  | 'excited'
  | 'happy'
  | 'playful'
  | 'curious'
  | 'surprised'
  | 'hopeful'
  | 'empathetic'
  | 'sad'
  | 'angry'
  | 'anxious'
  | 'calm';

/**
 * Tie-break order, most specific first. Two moods scoring equally on a compound label
 * resolve to whichever appears earlier here.
 */
export const MOOD_PRIORITY: AgentMood[] = [
  'angry',
  'sad',
  'anxious',
  'surprised',
  'playful',
  'empathetic',
  'excited',
  'curious',
  'hopeful',
  'happy',
  'calm',
];

/**
 * `calm` is the most recessive mood, so an unmatched label reads as "no strong signal"
 * rather than asserting a feeling the agent never expressed.
 */
export const DEFAULT_MOOD: AgentMood = 'calm';

const ALPHA_RE = /[a-z]/i;

function matchesWord(text: string, keyword: string): boolean {
  // word starts only: matching mid-word read "like a pirate" as `angry`, via the "irate" stem
  let start = 0;
  for (;;) {
    const at = text.indexOf(keyword, start);
    if (at === -1) return false;
    if (at === 0 || !ALPHA_RE.test(text[at - 1]!)) return true;
    start = at + 1;
  }
}

/**
 * Match a raw delivery label to a mood.
 *
 * Matching is keyword-based and deliberately lossy: the label space is open-ended, so an
 * unrecognized label resolves to `fallback` rather than a wrong guess.
 *
 * @param label - The raw delivery label, as the provider wrote it.
 * @param fallback - Mood to return when nothing matches. Pass `null` to handle the miss
 *   yourself. Defaults to {@link DEFAULT_MOOD}.
 *
 * @example
 * ```ts
 * matchMood('soft, with genuine care'); // 'empathetic'
 * matchMood('like a pirate'); // 'calm'
 * ```
 */
export function matchMood(label: string, fallback: AgentMood | null = DEFAULT_MOOD) {
  const text = label.toLowerCase();
  let best: AgentMood | null = null;
  let bestScore = 0;

  for (const mood of MOOD_PRIORITY) {
    let score = 0;
    for (const [keyword, weight] of Object.entries(MOOD_KEYWORDS[mood])) {
      if (matchesWord(text, keyword)) score += weight;
    }
    // strictly greater, so MOOD_PRIORITY breaks ties
    if (score > bestScore) {
      best = mood;
      bestScore = score;
    }
  }

  return best !== null ? best : fallback;
}
