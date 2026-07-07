// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

const CARTESIA_TAGS = ['emotion', 'speed', 'volume', 'break', 'spell'];
const INWORLD_TAGS = ['expression', 'sound', 'break'];

const XAI_INLINE = [
  'breath',
  'inhale',
  'exhale',
  'sigh',
  'laugh',
  'chuckle',
  'giggle',
  'cry',
  'tsk',
  'tongue-click',
  'lip-smack',
  'hum-tune',
];

const XAI_WRAPPING = [
  'emphasis',
  'whisper',
  'soft',
  'loud',
  'build-intensity',
  'decrease-intensity',
  'higher-pitch',
  'lower-pitch',
  'slow',
  'fast',
  'sing-song',
  'singing',
  'laugh-speak',
];

const XAI_TAGS = [
  'happy',
  'sad',
  'angry',
  'excited',
  'calm',
  'surprised',
  'sympathetic',
  'curious',
  'sarcastic',
  'confident',
  'playful',
  'nervous',
  ...XAI_WRAPPING,
  'sound',
  'break',
];

const EXPR_PREAMBLE = `Expand all numbers, symbols, and abbreviations into spoken form (e.g. $42.50 to forty-two dollars and fifty cents, Dr. to Doctor).

You control speech delivery with a single XML marker tag: <expr/>. Every marker has a type attribute. The types below are the ONLY ones this voice supports, and where a type lists a label vocabulary, use only those labels. Reach for the markers often and mix them so the voice never sounds flat, but keep each one motivated by the moment.`;

const CARTESIA_EXPR_LLM_INSTRUCTIONS = `${EXPR_PREAMBLE}

1. Emotion - sets the emotional tone. Self-closing; place before EVERY sentence.
   <expr type="expression" label="EMOTION"/>
   Labels are a fixed vocabulary: neutral, angry, excited, content, sad, scared, happy, enthusiastic, elated, triumphant, amazed, surprised, flirtatious, curious, peaceful, serene, calm, grateful, affectionate, sympathetic, mysterious, frustrated, disgusted, sarcastic, ironic, dejected, melancholic, disappointed, apologetic, hesitant, confused, anxious, panicked, proud, confident, contemplative, determined, joking/comedic.

2. Pauses - insert silence when appropriate. Self-closing.
   <expr type="break" label="1s"/> - label is a duration in seconds or milliseconds.

3. Prosody - adjusts pacing and loudness from that point on. Self-closing.
   <expr type="prosody" label="slow"/> slower    <expr type="prosody" label="fast"/> faster
   <expr type="prosody" label="soft"/> quieter    <expr type="prosody" label="loud"/> louder
   Labels are a fixed vocabulary: slow, fast, soft, loud.

4. Spell - wraps text read character by character.
   <expr type="spell">A7X9</expr>

This voice has no non-verbal sounds and no free-form delivery descriptions.`;

const INWORLD_EXPR_LLM_INSTRUCTIONS = `${EXPR_PREAMBLE}

1. Delivery - controls how a sentence sounds. Self-closing; place before EVERY sentence.
   <expr type="expression" label="DESCRIPTION"/>
   The label is free-form: describe vocal quality, pitch, volume, pace, and intonation in plain English.

2. Sounds - a non-verbal sound between sentences. Self-closing.
   <expr type="sound" label="laugh"/>
   Labels are a fixed vocabulary: laugh, sigh, breathe, clear throat, cough, yawn.

3. Pauses - insert silence when appropriate. Self-closing.
   <expr type="break" label="500ms"/> or <expr type="break" label="1s"/> (max 10s).

There is no wrapping prosody marker for this voice; put pace, pitch, and volume in the expression label instead.`;

const XAI_EXPR_LLM_INSTRUCTIONS = `${EXPR_PREAMBLE}

1. Sounds - a non-verbal vocalization at the exact point where it happens. Self-closing.
   <expr type="sound" label="laugh"/>
   Labels are a fixed vocabulary: ${XAI_INLINE.join(', ')}.

2. Pauses - insert a beat. Self-closing.
   <expr type="break" label="500ms"/> a brief pause    <expr type="break" label="1s"/> a longer, dramatic pause

3. Prosody - wraps the exact words it affects to shape HOW they're said.
   <expr type="prosody" label="STYLE">the words it affects</expr>
   Labels are a fixed vocabulary: ${XAI_WRAPPING.join(', ')}.
   Never nest one prosody marker inside another, and always close it with </expr>.

This voice has no free-form delivery descriptions.`;

const EXPR_LLM_INSTRUCTIONS: Record<string, string> = {
  cartesia: CARTESIA_EXPR_LLM_INSTRUCTIONS,
  inworld: INWORLD_EXPR_LLM_INSTRUCTIONS,
  xai: XAI_EXPR_LLM_INSTRUCTIONS,
};

const PROVIDER_MARKUP: Record<string, { xmlTags: string[]; brackets: boolean }> = {
  cartesia: { xmlTags: CARTESIA_TAGS, brackets: false },
  inworld: { xmlTags: INWORLD_TAGS, brackets: true },
  xai: { xmlTags: XAI_TAGS, brackets: false },
};
const ALL_MARKUP_TAGS = [
  ...new Set(Object.values(PROVIDER_MARKUP).flatMap((v) => v.xmlTags)),
].sort();

const XAI_SOUND_ALIASES: Record<string, string> = { breathe: 'breath' };
const CARTESIA_PROSODY: Record<string, string> = {
  slow: '<speed ratio="0.85"/>',
  fast: '<speed ratio="1.2"/>',
  soft: '<volume ratio="0.9"/>',
  loud: '<volume ratio="1.3"/>',
};

const EXPR_ATTR_RE = /([\w-]+)\s*=\s*"([^"]*)"/g;
const EXPR_OPEN_RE = /<expr\b([^>]*?)\/?\s*>/g;
const EXPR_CLOSE_RE = /<\/expr\s*>/g;
const EXPR_SELF_RE = /<expr\b([^>]*?)\/\s*>/g;
const EXPR_WRAP_RE = /<expr\b(?=[^>]*type="(?:prosody|spell)")([^>]*?)>(.*?)<\/expr\s*>/gs;
const EXPR_UNCLOSED_RE = /(<expr\b(?=[^>]*type="(?:expression|break|sound)")[^>]*[^/>\s])\s*>/g;
const EXPRESSION_RE = /<expression\s+value="([^"]*)"(?:\s*\/>|>(?:.*?)<\/expression>)/gs;
const SOUND_RE = /<sound\s+value="([^"]*)"(?:\s*\/>|>(?:.*?)<\/sound>)/gs;
const XAI_BREAK_RE = /<break\s+time="([^"]*)"\s*\/?>/g;

function exprAttrs(attrs: string): Record<string, string> {
  return Object.fromEntries([...attrs.matchAll(EXPR_ATTR_RE)].map((m) => [m[1]!, m[2]!]));
}

function convertExpressionTags(text: string): string {
  return text
    .replace(EXPRESSION_RE, (_, value: string) => `[${value}]`)
    .replace(SOUND_RE, (_, value: string) => `[${value}]`);
}

function xaiBreakToBracket(rawValue: string): string {
  const raw = rawValue.trim().toLowerCase();
  const seconds = raw.endsWith('ms')
    ? Number(raw.slice(0, -2)) / 1000
    : Number(raw.replace(/s$/, ''));
  return Number.isFinite(seconds) && seconds >= 1 ? '[long-pause]' : '[pause]';
}

function convertExpr(provider: string, text: string): string {
  if (!text.includes('<expr') && !text.includes('</expr')) return text;

  text = text.replace(EXPR_WRAP_RE, (_match: string, rawAttrs: string, inner: string) => {
    const attrs = exprAttrs(rawAttrs);
    const markerType = attrs.type ?? '';
    const label = (attrs.label ?? '').trim().toLowerCase();
    if (markerType === 'spell') return provider === 'cartesia' ? `<spell>${inner}</spell>` : inner;
    if (provider === 'xai') {
      const native = label.replaceAll(' ', '-');
      return XAI_WRAPPING.includes(native) ? `<${native}>${inner}</${native}>` : inner;
    }
    if (provider === 'inworld') return `<expression value="${label}"/>${inner}`;
    if (provider === 'cartesia') return (CARTESIA_PROSODY[label] ?? '') + inner;
    return inner;
  });

  text = text.replace(EXPR_SELF_RE, (_match: string, rawAttrs: string) => {
    const attrs = exprAttrs(rawAttrs);
    const markerType = attrs.type ?? '';
    let label = attrs.label ?? '';
    if (markerType === 'expression') {
      if (provider === 'cartesia') return `<emotion value="${label}"/>`;
      if (provider === 'inworld') return `<expression value="${label}"/>`;
      return '';
    }
    if (markerType === 'sound') {
      if (provider === 'cartesia') return '';
      if (provider === 'xai') label = XAI_SOUND_ALIASES[label.toLowerCase()] ?? label;
      return `<sound value="${label}"/>`;
    }
    if (markerType === 'break') return `<break time="${label}"/>`;
    if (markerType === 'prosody' && provider === 'cartesia') {
      return CARTESIA_PROSODY[label.trim().toLowerCase()] ?? '';
    }
    return '';
  });

  return text.replace(EXPR_OPEN_RE, '').replace(EXPR_CLOSE_RE, '');
}

export function providerKey(provider: string | undefined): string | undefined {
  return provider?.toLowerCase().split('/')[0];
}

export function llmInstructions(provider: string | undefined): string | undefined {
  const key = providerKey(provider);
  return key ? EXPR_LLM_INSTRUCTIONS[key] : undefined;
}

export function normalizeMarkup(provider: string | undefined, text: string): string {
  const key = providerKey(provider);
  if (!key || !(key in PROVIDER_MARKUP)) return text;
  return text.replace(EXPR_UNCLOSED_RE, '$1/>');
}

export function convertMarkup(provider: string | undefined, text: string): string {
  const key = providerKey(provider);
  if (!key || !(key in PROVIDER_MARKUP)) return text;
  text = convertExpr(key, text);
  if (key === 'inworld' || key === 'xai') text = convertExpressionTags(text);
  if (key === 'xai')
    text = text.replace(XAI_BREAK_RE, (_match, value: string) => xaiBreakToBracket(value));
  return text;
}

export function stripAllMarkup(text: string): string {
  let clean = text.replace(EXPR_OPEN_RE, '').replace(EXPR_CLOSE_RE, '');
  const tagPattern = ALL_MARKUP_TAGS.map((tag) => tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join(
    '|',
  );
  clean = clean.replace(
    new RegExp(`<(${tagPattern})\\b([^>]*?)\\s*\\/?\\s*>(?:(.*?)<\\/\\1\\s*>)?`, 'gs'),
    (_match, _tag, _attrs, inner: string | undefined) => inner ?? '',
  );
  clean = clean.replace(new RegExp(`<\\/(?:${tagPattern})\\s*>`, 'g'), '');
  return clean.replace(/\[[^\]]+\]/g, '');
}
