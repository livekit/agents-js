// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { ATTRIBUTE_TRANSCRIPTION_EXPRESSION } from '../constants.js';
import { convertExpressionTags, extractAndStrip } from './markup_utils.js';

export type ExpressiveTag = { type: string; value: string };

const CARTESIA_TAGS = ['emotion', 'speed', 'volume', 'break', 'spell'] as const;
const INWORLD_TAGS = ['expression', 'sound', 'break'] as const;

const CARTESIA_LLM_INSTRUCTIONS = `You have four self-closing XML tags. All end with />.

1. Emotion - sets the emotional tone. Place before EVERY sentence.
   <emotion value="EMOTION"/>
   Best results: neutral, angry, excited, content, sad, scared.
   Also available: happy, enthusiastic, elated, triumphant, amazed, surprised, flirtatious, curious, peaceful, serene, calm, grateful, affectionate, sympathetic, mysterious, frustrated, disgusted, sarcastic, ironic, dejected, melancholic, disappointed, apologetic, hesitant, confused, anxious, panicked, proud, confident, contemplative, determined, joking/comedic.

2. Speed and volume - adjust pacing and loudness.
   <speed ratio="VALUE"/> - speaking rate (0.6 to 1.5, default 1.0).
   <volume ratio="VALUE"/> - loudness (0.5 to 2.0, default 1.0).

3. Pauses - you can insert silence when appropriate.
   <break time="1s"/> - pause in seconds or milliseconds.

4. Spell - reads text character by character (for codes, IDs, or a spelled-out name).
   <spell>TEXT</spell>
   Keep punctuation out of <spell>.`;

const INWORLD_LLM_INSTRUCTIONS = `Write natural spoken sentences. No markdown, emojis, or special characters. Use contractions. Expand all numbers, symbols, and abbreviations into spoken form.

You have three XML tags. All are self-closing (end with />).

1. Delivery - controls how a sentence sounds. Place before EVERY sentence.
   <expression value="DESCRIPTION"/>
   Describe vocal quality, pitch, volume, pace, and intonation in plain English.

2. Sounds - produces a non-verbal sound. Use between sentences when natural.
   <sound value="laugh"/>, <sound value="sigh"/>, <sound value="breathe"/>, <sound value="clear throat"/>, <sound value="cough"/>, <sound value="yawn"/>

3. Pauses - you can insert silence when appropriate.
   <break time="500ms"/> or <break time="1s"/> (max 10s)`;

const PROVIDER_MARKUP: Record<string, { xmlTags: readonly string[]; brackets: boolean }> = {
  cartesia: { xmlTags: CARTESIA_TAGS, brackets: false },
  inworld: { xmlTags: INWORLD_TAGS, brackets: true },
};

const SELF_CLOSING_TAGS: Record<string, readonly string[]> = {
  cartesia: ['emotion', 'speed', 'volume', 'break'],
  inworld: ['expression', 'sound', 'break'],
};

const ALL_MARKUP_TAGS = Array.from(
  new Set(Object.values(PROVIDER_MARKUP).flatMap((spec) => spec.xmlTags)),
).sort();

export function llmInstructions(provider: string): string | undefined {
  if (provider === 'cartesia') return CARTESIA_LLM_INSTRUCTIONS;
  if (provider === 'inworld') return INWORLD_LLM_INSTRUCTIONS;
  return undefined;
}

export function splitMarkup(
  provider: string,
  text: string,
): { clean: string; tags: ExpressiveTag[] } {
  const spec = PROVIDER_MARKUP[provider];
  if (!spec) return { clean: text, tags: [] };
  const { clean, tags } = extractAndStrip({ text, ...spec });
  return { clean, tags: tags.map(([type, value]) => ({ type, value })) };
}

export function splitAllMarkup(text: string): { clean: string; tags: ExpressiveTag[] } {
  const { clean, tags } = extractAndStrip({ text, xmlTags: ALL_MARKUP_TAGS, brackets: true });
  return { clean, tags: tags.map(([type, value]) => ({ type, value })) };
}

export function expressionAttributes(
  tags: readonly ExpressiveTag[],
): Record<string, string> | undefined {
  const expression = tags.find((tag) => tag.type === 'expression' || tag.type === 'emotion');
  if (!expression) return undefined;
  return { [ATTRIBUTE_TRANSCRIPTION_EXPRESSION]: JSON.stringify({ value: expression.value }) };
}

export class TranscriptMarkupStripper {
  #buffer = '';
  #tags: ExpressiveTag[] = [];

  push(text: string): string {
    this.#buffer += text;
    if (this.hasOpenTag()) return '';
    const { clean, tags } = splitAllMarkup(this.#buffer);
    this.#buffer = '';
    this.#tags.push(...tags);
    return clean;
  }

  flush(): string {
    if (!this.#buffer) return '';
    const { clean, tags } = splitAllMarkup(this.#buffer);
    this.#buffer = '';
    this.#tags.push(...tags);
    return clean;
  }

  get tags(): readonly ExpressiveTag[] {
    return this.#tags;
  }

  expressionAttributes(): Record<string, string> | undefined {
    return expressionAttributes(this.#tags);
  }

  private hasOpenTag(): boolean {
    const lastLt = this.#buffer.lastIndexOf('<');
    if (lastLt > this.#buffer.lastIndexOf('>')) {
      const next = this.#buffer.slice(lastLt + 1, lastLt + 2);
      if (!next || next === '/' || /[A-Za-z]/.test(next)) return true;
    }
    return this.#buffer.lastIndexOf('[') > this.#buffer.lastIndexOf(']');
  }
}

export function normalizeMarkup(provider: string, text: string): string {
  const tags = SELF_CLOSING_TAGS[provider];
  if (!tags) return text;
  const pattern = tags.map((tag) => tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return text.replace(new RegExp(`<(${pattern})\\b([^>]*[^/])\\s*>`, 'g'), '<$1$2/>');
}

export function convertMarkup(provider: string, text: string): string {
  if (provider === 'inworld') return convertExpressionTags(text);
  return text;
}
