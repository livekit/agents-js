// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { MOOD_KEYWORDS } from './_mood_data.js';

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
export const DEFAULT_MOOD: AgentMood = 'calm';

function matchesWord(text: string, keyword: string): boolean {
  let start = 0;
  while (true) {
    const at = text.indexOf(keyword, start);
    if (at === -1) return false;
    if (at === 0 || !/\p{L}/u.test(text[at - 1]!)) return true;
    start = at + 1;
  }
}

export function matchMood(label: string): AgentMood;
export function matchMood(label: string, fallback: AgentMood): AgentMood;
export function matchMood(label: string, fallback: null): AgentMood | null;
export function matchMood(
  label: string,
  fallback: AgentMood | null = DEFAULT_MOOD,
): AgentMood | null {
  const text = label.toLowerCase();
  let best: AgentMood | null = null;
  let bestScore = 0;
  for (const mood of MOOD_PRIORITY) {
    const score = Object.entries(MOOD_KEYWORDS[mood]).reduce(
      (total, [keyword, weight]) => total + (matchesWord(text, keyword) ? weight : 0),
      0,
    );
    if (score > bestScore) {
      best = mood;
      bestScore = score;
    }
  }
  return best ?? fallback;
}

export { MOOD_KEYWORDS } from './_mood_data.js';
