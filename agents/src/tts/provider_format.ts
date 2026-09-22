// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared provider-specific TTS formatting logic.
 *
 * Both TTS plugins and the inference gateway delegate to this module so there is a single
 * source of truth for LLM instructions and markup stripping per provider.
 *
 * Provider docs:
 * - Cartesia: https://docs.cartesia.ai/build-with-cartesia/sonic-3/ssml-tags
 * - Cartesia: https://docs.cartesia.ai/build-with-cartesia/sonic-3/volume-speed-emotion
 * - Inworld: https://docs.inworld.ai/tts/capabilities/steering
 * - Inworld: https://docs.inworld.ai/tts/best-practices/prompting-for-tts-2
 * - xAI: https://docs.x.ai/developers/model-capabilities/audio/text-to-speech
 * - xAI: https://docs.x.ai/developers/model-capabilities/audio/voice
 * - Fish Audio: https://docs.fish.audio/developer-guide/core-features/emotions
 */
import { ATTRIBUTE_TRANSCRIPTION_EXPRESSION } from '../constants.js';
import { basic as tokenizeBasic } from '../tokenize/index.js';
import type { SentenceTokenizer } from '../tokenize/tokenizer.js';
import { type TimedString, createTimedString } from '../voice/io.js';
import {
  LEADING_WS,
  convertExpressionTags,
  dedupRemovalSpace,
  escapeRegExp,
  extractAndStrip,
  replaceWithGroups,
} from './markup_utils.js';
import { matchMood } from './mood.js';

/**
 * An expressive markup tag stripped from a transcript, surfaced for the frontend.
 *
 * `type` is the markup tag name (`"emotion"`, `"expression"`, `"sound"`, ...) or the expr
 * marker type. `value` is the spoken or semantic payload (the `value="..."` attribute, the
 * expr `label`, or the tag's inner text).
 */
export interface ExpressiveTag {
  type: string;
  value: string;
}

/**
 * Non-verbal vocalizations the TTS may produce (sounds that aren't words).
 *
 * A sparse opt-out: omitted keys default to ON, and a category set to `false` is never
 * advertised to the LLM — `{ laughing: false }` removes laughter and nothing else.
 * Together the keys cover every sound the providers offer.
 */
export interface NonverbalOptions {
  /** laugh, chuckle, giggle — and laugh-speak delivery */
  laughing?: boolean;
  /** audible breath, inhale, exhale */
  breathing?: boolean;
  sighing?: boolean;
  crying?: boolean;
  /** non-lexical voiced sounds — humming a tune, sing-song or sung delivery */
  vocalizing?: boolean;
  /** tsk, tongue-click, lip-smack */
  mouthSounds?: boolean;
  /** cough, clearing the throat, yawn */
  reflexSounds?: boolean;
}

/**
 * Steers verbal delivery and non-verbal sounds in generated speech.
 *
 * Every key is a sparse override on the default (full sound vocabulary, light fillers):
 * the expressive instructions already tell the LLM to match its delivery to the register
 * of the moment, so most agents need no steering at all — set a key only to take an option
 * away regardless of context.
 */
export interface SpeechSteeringOptions {
  /**
   * Filler words such as "um" / "uh". On by default
   * ({@link DEFAULT_SPEECH_STEERING_OPTIONS}); set `false` to opt out.
   */
  disfluencies?: boolean;
  /**
   * Which non-verbal sounds the TTS may make. `true` (and omitting the key) keeps the
   * provider's full vocabulary, `false` disables every sound, and a
   * {@link NonverbalOptions} object toggles per category (omitted categories stay enabled).
   */
  nonverbalSounds?: boolean | NonverbalOptions;
  pace?: 'slow' | 'normal' | 'fast';
}

/** The default steering: full sound vocabulary, light fillers. */
export const DEFAULT_SPEECH_STEERING_OPTIONS: SpeechSteeringOptions = { disfluencies: true };

/** What the expressive markup pipeline can do with a given voice. */
export interface MarkupInfo {
  /** {@link NonverbalOptions} field -> the labels it governs; an absent field is a no-op */
  nonverbals: Partial<Record<NonverbalField, string[]>>;
}

type NonverbalField = keyof NonverbalOptions;

const CARTESIA_TAGS = ['emotion', 'speed', 'volume', 'break', 'spell'];

const INWORLD_TAGS = ['expression', 'sound', 'break'];

// xAI Grok TTS speech tags, from the xAI docs
// (https://docs.x.ai/developers/rest-api-reference/inference/voice).
//
// The LLM is instructed in the expr dialect (below); these native tag names serve two
// purposes: XAI_WRAPPING is the label vocabulary expr prosody markers lower to, and all
// of them stay in XAI_TAGS so a hallucinated native tag is still stripped from the
// transcript rather than leaking. The intermediate <sound value="NAME"/> and
// <break time="..."/> tags that expr lowering produces are rewritten to xAI's native
// brackets by convertMarkup — <sound value="X"/> -> [X] and <break> -> [pause] or
// [long-pause] by duration. Prosody is angle-bracketed (native).
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
  'emphasis', // stress the wrapped words
  'whisper', // quiet, intimate
  'soft', // lower volume
  'loud', // higher volume
  'build-intensity', // ramp energy up over the span
  'decrease-intensity', // ease energy off over the span
  'higher-pitch',
  'lower-pitch',
  'slow',
  'fast',
  'sing-song', // playful, musical lilt
  'singing', // actually sung
  'laugh-speak', // talk through a laugh
];
const XAI_EMOTIONS = [
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
];
// all tags are XML in the transcript, so all are stripped. inline sounds are the single
// "sound" tag (<sound value="NAME"/>, XAI_INLINE lists the NAMEs), and pauses use
// "break" (<break time="..."/>), both modeled on Inworld.
const XAI_TAGS = [...XAI_EMOTIONS, ...XAI_WRAPPING, 'sound', 'break'];

// xAI has two pause levels ([pause], [long-pause]); map an Inworld-style <break time="X"/>
// to the longer one past ~1s. This is the only per-provider bit convertMarkup needs.
const XAI_BREAK_RE = /<break\s+time="([^"]*)"\s*\/?>/g;

function parseDurationSeconds(raw: string): number {
  const value = raw.trim().toLowerCase();
  const parsed = value.endsWith('ms')
    ? Number.parseFloat(value.slice(0, -2)) / 1000
    : Number.parseFloat(value.replace(/s+$/, ''));
  return Number.isNaN(parsed) ? 0 : parsed;
}

function xaiBreakToBracket(_match: string, time: string): string {
  return parseDurationSeconds(time) >= 1 ? '[long-pause]' : '[pause]';
}

// Fish Audio (s2 family) speech markers, from the Fish docs
// (https://docs.fish.audio/developer-guide/core-features/emotions).
//
// The LLM is instructed in the expr dialect (below); expr lowering produces the
// framework-standard intermediates (<expression value="..."/>, <sound value="..."/>,
// <break time="..."/>, <emphasis>word</emphasis>) and convertMarkup rewrites them to
// Fish's native square brackets: [very EMOTION], [SOUND], [break]/[long-break], and
// [emphasis] word (a prefix marker stressing the word that follows). Tone wrapping
// (<expr type="prosody" label="whispering">...</expr>) lowers directly to Fish's prefix
// form, [whispering] followed by the span. The tag names stay in FISHAUDIO_TAGS so
// hallucinated native markup is still stripped from transcripts.
//
// Every label below is from Fish's documented vocabulary, and every emotion maps to a
// non-fallback mood in mood.ts so lk.expression stays meaningful for clients.
const FISHAUDIO_EMOTIONS = [
  'regretful',
  'hopeful',
  'happy',
  'excited',
  'curious',
  'surprised',
  'sad',
  'empathetic',
  'sarcastic',
  'calm',
  'angry',
  'worried',
  'nervous',
  'confident',
  'grateful',
  'delighted',
  'disappointed',
  'frustrated',
  'determined',
];
const FISHAUDIO_SOUNDS = [
  'laughing',
  'chuckling',
  'clear throat',
  'sighing',
  'gasping',
  'groaning',
  'yawning',
  'sobbing',
];
// Fish's tone controls: prefix markers steering the delivery of the words after them.
// Neutral delivery styles, so they are never steering-filtered (same stance as xAI's
// whisper/pitch wraps).
const FISHAUDIO_TONES = ['whispering', 'soft', 'shouting', 'hurried'];
const FISHAUDIO_TAGS = ['expression', 'sound', 'break', 'emphasis'];

const FISHAUDIO_EXPRESSION_RE = /<expression\s+value="([^"]*)"(?:\s*\/>|>(?:.*?)<\/expression>)/g;
const FISHAUDIO_BREAK_RE = /<break\s+time="([^"]*)"\s*\/?>/g;
const FISHAUDIO_EMPHASIS_RE = /<emphasis(?:\s[^>]*)?>([^<]*)<\/emphasis\s*>/gi;

function fishaudioExpressionToBracket(_match: string, value: string): string {
  // intensify with a leading "very" so the emotion lands harder in Fish's audio
  // ([very regretful] steers more strongly than [regretful]); never doubled
  let label = value.trim();
  if (label && !label.toLowerCase().startsWith('very ')) {
    label = `very ${label}`;
  }
  return `[${label}]`;
}

function fishaudioBreakToBracket(_match: string, time: string): string {
  // Fish has two pause levels ([break], [long-break]); use the longer past ~1s
  return parseDurationSeconds(time) >= 1 ? '[long-break]' : '[break]';
}

// --- LiveKit expression markers (expr) ---
// The LLM emits a single marker tag, <expr type="..." label="..."/>, instead of
// provider-native tags. The *syntax* is shared, but each provider gets its own instruction
// block advertising only the types and label vocabularies it actually supports — providers
// offer different sound effects, some take only a discrete emotion vocabulary rather than
// free-form delivery descriptions, and only some have wrapping prosody. Types (per
// provider):
//   expression (self-closing) - delivery/emotion for what follows; free-form for
//                               Inworld, Cartesia's discrete emotion vocabulary, absent
//                               for xAI
//   break      (self-closing) - pause, label is a duration ("500ms", "1s"); all providers
//   sound      (self-closing) - non-verbal vocalization from the provider's own list
//                               (Inworld: laugh/sigh/..., xAI: chuckle/tsk/...); absent
//                               for Cartesia
//   prosody    (wrapping)     - <expr type="prosody" label="whisper">words</expr>, labels
//                               from xAI's wrapping-tag list; for Cartesia a self-closing
//                               point control (slow/fast/soft/loud -> coarse speed/volume
//                               ratios); absent for Inworld (folded into expression)
//   spell      (wrapping)     - <expr type="spell">A7X9</expr> character-by-character
//                               readout; Cartesia only
// convertMarkup lowers expr to each provider's native syntax before synthesis (via the
// existing framework-standard tags, so the per-provider conversions below still apply),
// and the transcript strippers remove expr markers in a dedicated pre-pass so the
// type/label pair surfaces correctly as an ExpressiveTag. This is the only dialect the
// LLM is taught — llmInstructions() uses it; the provider-native tag tables remain solely
// so hallucinated native markup is still stripped/converted instead of leaking.

const EXPR_PREAMBLE = `You control speech delivery with a single XML marker tag: <expr/>. Every marker has a \
type attribute. Use only the marker types listed below, and where a type lists a label \
vocabulary, only those labels. Use the markers often and diversify them so the voice \
never sounds flat while ensuring the markers are appropriate for the moment. Write the \
words themselves the way people talk: use contractions ("I'm", "you're", "don't") — \
spelled-out forms like "I am" or "do not" sound stiff when spoken.

Just as important is knowing when NOT to reach for a marker. Reserve surprise openers \
like "oh" or "ah" for genuine surprise — an ordinary request isn't one. Don't stack markers \
on short replies or decorate every sentence. If a reaction wouldn't happen in a real \
conversation, skip it — there's always another genuine beat to lean into.

Match your delivery to the REGISTER of the moment, and reassess every turn. When the \
moment is professional, high-stakes, or emotionally heavy — bad news, an emergency, \
real distress — keep delivery composed and restrained. When the moment is casual, \
playful, or celebratory, let it loosen and brighten. A serious turn in an otherwise \
casual conversation still gets a composed reply.`;

const CARTESIA_EXPR_LLM_INSTRUCTIONS =
  EXPR_PREAMBLE +
  `

1. Emotion - sets the emotional tone. Self-closing; place before EVERY sentence.
   <expr type="expression" label="EMOTION"/>
   Labels are a fixed vocabulary, NOT free-form descriptions. Best results: neutral, \
angry, excited, content, sad, scared.
   Also available: happy, enthusiastic, elated, triumphant, amazed, surprised, \
flirtatious, curious, peaceful, serene, calm, grateful, affectionate, sympathetic, \
mysterious, frustrated, disgusted, sarcastic, ironic, dejected, melancholic, \
disappointed, apologetic, hesitant, confused, anxious, panicked, proud, confident, \
contemplative, determined, joking/comedic.

2. Pauses - insert silence when appropriate. Self-closing.
   <expr type="break" label="1s"/> - label is a duration in seconds or milliseconds.

3. Prosody - adjusts pacing and loudness from that point on. Self-closing.
   <expr type="prosody" label="slow"/> slower    <expr type="prosody" label="fast"/> faster
   <expr type="prosody" label="soft"/> quieter    <expr type="prosody" label="loud"/> louder
   Labels are a fixed vocabulary: slow, fast, soft, loud.

4. Spell - wraps text read character by character (codes, IDs, or a spelled-out name).
   <expr type="spell">A7X9</expr>
   Keep punctuation out of a spell marker — a period inside is read as "dot"; add \
spaces inside for grouped pauses (<expr type="spell">ABC 123</expr>).

This voice has no non-verbal sounds and no free-form delivery descriptions — do not \
invent other types or labels.

Examples:
  <expr type="expression" label="excited"/> I can't wait to tell you! <expr type="expression" label="happy"/> This is going to be great!
  <expr type="expression" label="curious"/> Really? <expr type="break" label="500ms"/> <expr type="expression" label="excited"/> Tell me more!
  Your code is <expr type="spell">A7X9</expr>. <expr type="break" label="1s"/> <expr type="expression" label="calm"/> Got it?`;

const INWORLD_SOUNDS = ['laugh', 'sigh', 'breathe', 'clear throat', 'cough', 'yawn'];

const INWORLD_EXAMPLES = [
  '<expr type="expression" label="say really playfully"/> Okay okay, why did the burger go to the gym? <expr type="break" label="500ms"/> <expr type="expression" label="really bright, a little fast"/> Because it wanted better buns! <expr type="sound" label="laugh"/>',
  '<expr type="expression" label="a little sheepish, apologetic"/> Ah man, yeah that\'s on us. <expr type="expression" label="speak really calmly"/> Lemme see what I can do.',
  '<expr type="sound" label="sigh"/> <expr type="expression" label="speak softly, almost a whisper"/> I know it\'s been a rough week.',
  '<expr type="expression" label="really amiable and welcoming"/> Welcome to the hotel. <expr type="expression" label="gently inquisitive, slightly fast"/> How can I help you today?',
  '<expr type="expression" label="gently easygoing and reassuring"/> That\'s all set. <expr type="break" label="300ms"/> <expr type="expression" label="slow and really clearly enunciated"/> Your confirmation code is B 4 J 7.',
  // persona carried into the tags: casual words, casual labels
  '<expr type="expression" label="really chill, a little fast"/> Yeah, of course! <expr type="expression" label="casual, almost fast"/> Gimme one sec, pulling it up now.',
];

/** Drop example lines that demonstrate a *vocabulary* label not in `allowed`. */
function soundExamples(examples: string[], allowed: string[], vocabulary: string[]): string[] {
  const removed = vocabulary.filter((s) => !allowed.includes(s));
  return examples.filter((ex) => !removed.some((s) => ex.includes(`label="${s}"`)));
}

function numberedSections(sections: string[]): string {
  return sections.map((section, i) => `${i + 1}. ${section}`).join('\n\n');
}

function inworldExprLlmInstructions(sounds: string[]): string {
  const sections = [
    `Delivery - controls how a sentence sounds. Self-closing; place before EVERY sentence.
   <expr type="expression" label="DESCRIPTION"/>
   The label is free-form: describe vocal quality, pitch, volume, pace, and intonation \
in plain English — "say really playfully", "slightly surprised, amiable", "sound a little \
concerned", "drop to almost a whisper", "speak really slowly and clearly, patient and \
reassuring".
   Match the expression tag's energy to the sentence's punctuation. An exclamation \
needs a bright or upbeat label (e.g. "bright, upbeat energy"); a calm or reassuring \
label flattens the "!". Never lead an exclamatory sentence with a calm tag.
   Put each question in its own sentence — don't comma-splice it onto a statement. \
Write "Welcome to the hotel. How can I help you today?", not "Welcome to the hotel, \
how can I help you today?", so the question carries its own delivery tag instead of \
inheriting the statement's.
   Never put "questioning" in a tag — describe the mood alone and let the question \
mark carry the intonation.
   Name a mood or speaking style, not a mechanical pitch contour. "gently upbeat, \
amiable" steers far more reliably than "rising tone".
   Use at most two adjectives per tag, and make sure they align — with the mood of \
the sentence and with each other. Clashing descriptors ("calm, excited") cancel out \
and muddy the delivery.
   Put a degree modifier in EVERY tag — "a little", "almost", "slightly", "gently", \
"really" — to set the exact strength of the feeling: "a little amused" or "almost a \
whisper" lands truer than "amused" or "whisper", and "really excited" turns the \
delivery up when the moment truly peaks. Most moments call for a shade, not the \
extreme — default to the softeners and save "really" for true peaks.
   Carry your persona into the tags — the labels should sound like the character, \
not generic stage directions. An amiable, casual persona tags with "really relaxed \
and amiable" or "casual, a little playful"; a formal concierge tags the same \
sentence "gently courteous, composed". Delivery that contradicts who you are reads \
as a different speaker.
   Don't open a turn with a "slow" tag. The first expression colors the whole turn, \
and a slow lead flattens questions and drags the energy down. Keep the pace neutral \
by default and reserve slow, clearly-enunciated delivery for the specific line that \
needs it (a total, date, address, or confirmation code).
   Rotate expression labels — don't reuse the same one two turns in a row, and vary \
the descriptor. A starting palette:
     greeting / amiable open: "really amiable and welcoming" / "gently bright, \
heartfelt" / "cheerful, really glad you called"
     asking a question: "gently upbeat and amiable" / "really open and inquisitive" / \
"gently inquisitive, attentive"
     good news / exclamation: "really bright, upbeat energy" / "really delighted and \
glad" / "gently pleased and bright"
     reassuring / taking a request in stride: "really calm and confident" / \
"gently easygoing and reassuring" / "really relaxed and grounded"
     empathy / a problem or bad news: "really soft, with tender care" / \
"gently concerned, caring" / "almost a murmur, gentle and steady"
     reading back a total, date, or code: "slow and really clearly enunciated"`,
  ];

  if (sounds.length) {
    const fits = ' (a clear-throat when shifting to a new step or topic, for example)';
    let section = `Sounds - a non-verbal sound between sentences. Self-closing.
   <expr type="sound" label="${sounds[0]}"/>
   Labels are a fixed vocabulary: ${sounds.join(', ')}.
   Use non-verbal sounds sparingly, and never the same one twice in a row — reach for \
one only where it genuinely fits${sounds.includes('clear throat') ? fits : ''}. An enabled \
sound gets over-used otherwise.`;
    if (sounds.includes('breathe')) {
      section += `
   Use the "breathe" sound only for a real, gentle breath, never as filler — on this \
model it easily reads as a weary or impatient sigh, which sounds wrong in a support \
setting.`;
    }
    sections.push(section);
  }

  sections.push(`Pauses - insert silence when appropriate. Self-closing.
   <expr type="break" label="500ms"/> or <expr type="break" label="1s"/> (max 10s).
   A period or an ellipsis (...) already creates a pause, so don't put a break marker \
right next to one — pick one or the other.
   After any <expr type="break"/>, give the sentence that follows its own expression \
tag — a fresh one, not necessarily the same as before (a break is often where the mood \
shifts). A break resets delivery to neutral, so an untagged sentence after a break is \
spoken flat.`);

  const parts = [
    EXPR_PREAMBLE,
    numberedSections(sections),
    'There is no wrapping prosody marker for this voice — put pace, pitch, and volume in ' +
      'the expression label instead.',
    `Write for the EAR, not the page: no em or en dashes anywhere in spoken text — \
use a comma or a period for a short beat, or a break marker for a real pause. Avoid \
semicolons, mid-sentence colons, and parenthetical asides; rewrite them as separate \
sentences or commas.`,
    `When the conversation is in another language, still write every marker label in \
English — delivery descriptions and sound names steer the voice and are never \
translated.`,
  ];

  if (sounds.includes('laugh')) {
    parts.push(
      'Laughter belongs only in genuinely playful or celebratory beats, never at ' +
        'a serious moment.',
    );
  }

  const examples = soundExamples(INWORLD_EXAMPLES, sounds, INWORLD_SOUNDS);
  if (examples.length) {
    parts.push('Examples:\n' + examples.map((ex) => `  ${ex}`).join('\n'));
  }
  return parts.join('\n\n');
}

const XAI_EXAMPLES = [
  'So I walked in and <expr type="break" label="500ms"/> <expr type="sound" label="inhale"/> there it was! <expr type="prosody" label="whisper">It was a secret the whole time.</expr>',
  '<expr type="prosody" label="build-intensity">This is going to be so good.</expr> <expr type="prosody" label="loud">I can\'t wait!</expr>',
  '<expr type="prosody" label="soft">Hey.</expr> <expr type="sound" label="sigh"/> <expr type="prosody" label="lower-pitch">I know it\'s been a rough week.</expr> I\'m right here.',
  '<expr type="prosody" label="higher-pitch">You did not just say that</expr> okay, <expr type="prosody" label="fast">tell me everything.</expr>',
  // sound-free, so at least one example survives any steering filter; the break lands
  // mid-sentence before the key detail, never beside sentence punctuation
  '<expr type="prosody" label="emphasis">Everything</expr> is confirmed for <expr type="break" label="500ms"/> Thursday the <expr type="prosody" label="emphasis">ninth</expr>. <expr type="prosody" label="slow">Is there anything else I can help you with?</expr>',
];

function xaiExprLlmInstructions(sounds: string[], prosody: string[]): string {
  const sections: string[] = [];
  if (sounds.length) {
    sections.push(`Sounds - a non-verbal vocalization at the exact point where it happens. Self-closing.
   <expr type="sound" label="${sounds[0]}"/>
   Labels are a fixed vocabulary: ${sounds.join(', ')}.
   Use non-verbal sounds sparingly, and never the same one twice in a row — reach for \
one only where it genuinely fits. An enabled sound gets over-used otherwise.`);
  }

  sections.push(`Pauses - insert silence when appropriate. Self-closing.
   <expr type="break" label="500ms"/> a brief pause    <expr type="break" label="1s"/> a longer, dramatic pause
   NEVER place a break next to a period, question mark, exclamation point, or ellipsis \
— sentence punctuation already pauses, and a break beside it double-pauses. Most \
replies need no break markers at all; reserve them for a deliberate mid-sentence beat \
before a key detail (a date, a name, a number).`);

  const tones = prosody.filter((p) => p !== 'emphasis');
  sections.push(`Prosody - wraps a span delivered in a distinct style, to shape HOW it's said.
   <expr type="prosody" label="STYLE">the words it affects</expr>
   Labels are a fixed vocabulary: ${tones.join(', ')}.
   Use one only where the moment clearly calls for it — most sentences need none. \
Never nest one prosody marker inside another, and always close it with </expr>.`);

  sections.push(`Emphasis - stresses exactly the ONE word it wraps.
   Are you <expr type="prosody" label="emphasis">sure</expr> you want to do this?
   Wrap a single word, never a phrase, and never write it in all-caps — caps are read \
out as individual letters. Never nest it, and always close it with </expr>.`);

  const parts = [
    EXPR_PREAMBLE,
    numberedSections(sections),
    'This voice has no free-form delivery descriptions — shape delivery entirely through ' +
      (sounds.length ? 'prosody markers, sounds, pauses' : 'prosody markers, pauses') +
      ', punctuation, and word choice.',
    `Write for the EAR, not the page: no em or en dashes anywhere in spoken text — \
use a comma or a period for a short beat, or a break marker for a real pause. Avoid \
semicolons, mid-sentence colons, and parenthetical asides; rewrite them as separate \
sentences or commas.`,
    `When the conversation is in another language, still write every marker label in \
English — labels are a fixed vocabulary, never translated.`,
    `Key details deserve care: stress the load-bearing word of a date, amount, or \
name with the emphasis marker, and wrap a dense or easy-to-mishear span in \
<expr type="prosody" label="slow">...</expr>. Read codes and reference numbers \
character by character, spelled out with spaces, so each one lands.`,
  ];

  // Vocabulary-specific register guidance on top of the preamble's neutral rule,
  // mentioning only concepts this steering leaves enabled (whisper/soft/loud are
  // neutral delivery controls, never filtered).
  const register = [
    'Whisper and soft belong to gentle or conspiratorial beats; loud only to ' +
      'genuinely high-energy ones.',
  ];
  if (['laugh', 'chuckle', 'giggle'].some((s) => sounds.includes(s))) {
    register.push(
      'Laughter is RARE: a laugh, chuckle, or giggle belongs only where something ' +
        'is genuinely funny — friendliness, agreement, or mild amusement is not a ' +
        'reason, and never laugh at your own lines. Most replies have no laughter ' +
        'at all.',
    );
  }
  parts.push(register.join(' '));

  const examples = soundExamples(
    XAI_EXAMPLES,
    [...sounds, ...prosody],
    [...XAI_INLINE, ...XAI_WRAPPING],
  );
  if (examples.length) {
    parts.push('Examples:\n' + examples.map((ex) => `  ${ex}`).join('\n'));
  }
  return parts.join('\n\n');
}

// Examples carried over from the original Fish expressive block (PR #6232), rewritten
// in the expr dialect. Breaks appear only mid-sentence, never beside a period/?/! —
// an example pairing a break with sentence punctuation few-shots the LLM into
// double-pausing every boundary.
const FISHAUDIO_EXAMPLES = [
  '<expr type="expression" label="excited"/> That\'s hilarious! <expr type="sound" label="laughing"/> <expr type="expression" label="happy"/> You always lighten the mood.',
  '<expr type="expression" label="empathetic"/> <expr type="sound" label="clear throat"/> That sounds like a <expr type="prosody" label="emphasis">really</expr> difficult experience.',
  '<expr type="expression" label="sad"/> Oh, my goodness <expr type="sound" label="clear throat"/> <expr type="break" label="2s"/> that\'s a real shame.',
  '<expr type="expression" label="frustrated"/> <expr type="sound" label="sighing"/> I\'ve been going in circles with this all morning. <expr type="expression" label="determined"/> Okay. One more try.',
  // sound-free, so at least one example survives any steering filter
  '<expr type="expression" label="happy"/> You\'re all set for <expr type="break" label="500ms"/> Thursday the <expr type="prosody" label="emphasis">ninth</expr>. <expr type="expression" label="curious"/> Is there anything else I can help you with?',
  // sound-free tone example: the wrap is scoped to the span, not the sentence
  '<expr type="expression" label="delighted"/> <expr type="prosody" label="whispering">Okay, don\'t tell anyone yet</expr> <expr type="expression" label="excited"/> but I think we actually pulled it off!',
];

// The original block baked light disfluencies into the few-shots — that's what made
// fillers actually show up in generations. Appended only while steering has
// disfluencies enabled, so the examples never contradict the "no fillers" guideline.
const FISHAUDIO_DISFLUENT_EXAMPLES = [
  '<expr type="expression" label="curious"/> Um, uh... really? <expr type="expression" label="sad"/> Well, I\'m really sorry to hear that.',
  '<expr type="expression" label="regretful"/> I really wish I\'d, um, called sooner. <expr type="expression" label="hopeful"/> But I\'m here now if, if you want to talk.',
  '<expr type="expression" label="surprised"/> What?! No way! I, I\'m flabbergasted! <expr type="expression" label="sarcastic"/> Fair play, I guess.',
];

function fishaudioExprLlmInstructions(sounds: string[], disfluencies = true): string {
  const sections = [
    `Emotion - sets how a sentence sounds. Self-closing; place at the START of a sentence.
   <expr type="expression" label="EMOTION"/>
   Labels are a fixed vocabulary, NOT free-form descriptions: ${FISHAUDIO_EMOTIONS.join(', ')}.
   Give every sentence its own emotion marker — repeat the same label to carry a \
feeling across sentences, or switch labels when the feeling shifts.`,
  ];

  if (sounds.length) {
    sections.push(`Sounds - a non-verbal sound between sentences. Self-closing.
   <expr type="sound" label="${sounds[0]}"/>
   Labels are a fixed vocabulary: ${sounds.join(', ')}.
   Use non-verbal sounds sparingly, and never the same one twice in a row — reach for \
one only where it genuinely fits. An enabled sound gets over-used otherwise.`);
  }

  sections.push(`Pauses - insert silence when appropriate. Self-closing.
   <expr type="break" label="500ms"/> or <expr type="break" label="2s"/>.
   NEVER place a break next to a period, question mark, exclamation point, or ellipsis \
— sentence punctuation already pauses, and a break beside it double-pauses. Most \
replies need no break markers at all; reserve them for a deliberate mid-sentence beat \
before a key detail (a date, a name, a number).`);

  sections.push(`Tone - wraps a span delivered in a distinct style.
   <expr type="prosody" label="whispering">don't tell anyone yet.</expr>
   Labels are a fixed vocabulary: ${FISHAUDIO_TONES.join(', ')}.
   Use a tone only where the moment clearly calls for one — most sentences need \
none. Never nest tone markers, and always close the tag with </expr>.`);

  sections.push(`Emphasis - stresses exactly the ONE word it wraps.
   Are you <expr type="prosody" label="emphasis">sure</expr> you want to do this?
   Wrap a single word, never a phrase. Never nest it, and always close it with </expr>.`);

  const parts = [
    EXPR_PREAMBLE,
    numberedSections(sections),
    `Write for the EAR, not the page: no em or en dashes anywhere in spoken text — \
use a comma or a period for a short beat, or a break marker for a real pause. Avoid \
semicolons, mid-sentence colons, and parenthetical asides; rewrite them as separate \
sentences or commas.`,
    `When the conversation is in another language, still write every marker label in \
English — labels are a fixed vocabulary, never translated.`,
  ];

  // Vocabulary-specific register guidance on top of the preamble's neutral rule.
  // Each clause mentions only concepts this steering actually enables, so an
  // opted-out option is never referenced (not even prohibitively).
  const register = [
    'At heavy moments reach for empathetic, sad, regretful, or hopeful — never a ' +
      'bright label like "happy" or "excited" against hard news; bright labels belong ' +
      'to bright moments.',
    'Whispering and soft belong to gentle or conspiratorial beats; shouting only to ' +
      'genuinely high-energy ones.',
  ];
  if (['laughing', 'chuckling'].some((s) => sounds.includes(s))) {
    register.push(
      'Laughter belongs only in genuinely playful or celebratory beats, never at ' +
        'a serious moment.',
    );
  }
  if (disfluencies) {
    register.push(
      'Save fillers for relaxed moments — never in an emergency or against grave news.',
    );
  }
  parts.push(register.join(' '));

  const pool = [...FISHAUDIO_EXAMPLES, ...(disfluencies ? FISHAUDIO_DISFLUENT_EXAMPLES : [])];
  const examples = soundExamples(pool, sounds, FISHAUDIO_SOUNDS);
  if (examples.length) {
    parts.push('Examples:\n' + examples.map((ex) => `  ${ex}`).join('\n'));
  }
  return parts.join('\n\n');
}

// Every provider's full expr sound vocabulary (the advertised labels before any
// speechSteering filtering). Providers absent here have no non-verbal sounds.
const PROVIDER_SOUNDS: Record<string, string[]> = {
  inworld: INWORLD_SOUNDS,
  xai: XAI_INLINE,
  fishaudio: FISHAUDIO_SOUNDS,
};

type NonverbalTable = Record<string, Partial<Record<NonverbalField, string[]>>>;

/**
 * Labels from a per-provider governance table that `steering` disables.
 *
 * `nonverbalSounds` accepts a boolean or a sparse per-category object: `true` (like
 * omitting the key) keeps the full vocabulary, `false` disables every sound, and in an
 * object an omitted category stays ENABLED — `{ laughing: false }` removes laughter and
 * nothing else.
 */
function steeringRemoved(
  table: NonverbalTable,
  provider: string,
  steering: SpeechSteeringOptions | undefined,
): Set<string> {
  const nonverbals = steering?.nonverbalSounds;
  const labels = table[provider];
  if (nonverbals === undefined || nonverbals === true || labels === undefined) {
    return new Set();
  }
  if (nonverbals === false) {
    return new Set(Object.values(labels).flat());
  }
  const removed = new Set<string>();
  for (const [field, fieldLabels] of Object.entries(labels) as [NonverbalField, string[]][]) {
    if (nonverbals[field] === false) {
      for (const label of fieldLabels) removed.add(label);
    }
  }
  return removed;
}

/**
 * The provider's sound vocabulary minus labels steering disables.
 *
 * Every label is governed by a {@link NonverbalOptions} field, so passing
 * `nonverbalSounds: false` returns an empty list — the instruction builders then omit the
 * Sounds section entirely.
 */
function allowedSounds(provider: string, steering: SpeechSteeringOptions | undefined): string[] {
  const removed = steeringRemoved(NONVERBAL_SOUND_LABELS, provider, steering);
  return (PROVIDER_SOUNDS[provider] ?? []).filter((s) => !removed.has(s));
}

/**
 * The provider's wrapping-prosody vocabulary minus labels steering disables.
 *
 * Unlike sounds, only the vocal-style labels (laugh-speak, singing, ...) are governed —
 * neutral delivery controls (emphasis, whisper, pitch, pace) always survive, so the result
 * is never empty.
 */
function allowedProsody(provider: string, steering: SpeechSteeringOptions | undefined): string[] {
  const removed = steeringRemoved(NONVERBAL_PROSODY_LABELS, provider, steering);
  return (PROVIDER_PROSODY[provider] ?? []).filter((p) => !removed.has(p));
}

// NonverbalOptions field -> the provider's expr sound labels it governs. A provider
// absent here (cartesia) has no non-verbal sounds; an empty list means the provider
// has no sound for that field (nothing to filter). allowedSounds uses this to remove
// disabled labels from the advertised vocabulary, so a sound steering turns off is never
// exposed to the LLM in the first place. Every label in PROVIDER_SOUNDS must be governed
// by exactly one field, so a steering config controls the full vocabulary.
const NONVERBAL_SOUND_LABELS: NonverbalTable = {
  inworld: {
    laughing: ['laugh'],
    breathing: ['breathe'],
    sighing: ['sigh'],
    crying: [],
    vocalizing: [],
    mouthSounds: [],
    reflexSounds: ['cough', 'clear throat', 'yawn'],
  },
  xai: {
    laughing: ['laugh', 'chuckle', 'giggle'],
    breathing: ['breath', 'inhale', 'exhale'],
    sighing: ['sigh'],
    crying: ['cry'],
    vocalizing: ['hum-tune'], // non-lexical voiced sounds
    mouthSounds: ['tsk', 'tongue-click', 'lip-smack'],
    reflexSounds: [], // xAI has no cough/yawn sounds
  },
  fishaudio: {
    laughing: ['laughing', 'chuckling'],
    breathing: ['gasping'],
    sighing: ['sighing'],
    crying: ['sobbing'],
    vocalizing: ['groaning'],
    mouthSounds: [],
    reflexSounds: ['clear throat', 'yawning'],
  },
};

// NonverbalOptions field -> the provider's wrapping-prosody labels it governs.
// Sparse on purpose: only vocal-style prosody (talking through a laugh, singing)
// is steerable; neutral delivery controls are never filtered.
const NONVERBAL_PROSODY_LABELS: NonverbalTable = {
  xai: {
    laughing: ['laugh-speak'],
    vocalizing: ['sing-song', 'singing'],
  },
};

// Every provider's full wrapping-prosody vocabulary (only xAI has one).
const PROVIDER_PROSODY: Record<string, string[]> = {
  xai: XAI_WRAPPING,
};

/** {@link NonverbalOptions} field -> the sound/prosody labels it governs for `provider`. */
export function supportedNonverbals(provider: string): Partial<Record<NonverbalField, string[]>> {
  const merged: Partial<Record<NonverbalField, string[]>> = {};
  for (const table of [NONVERBAL_SOUND_LABELS, NONVERBAL_PROSODY_LABELS]) {
    for (const [field, labels] of Object.entries(table[provider] ?? {}) as [
      NonverbalField,
      string[],
    ][]) {
      if (labels.length) {
        merged[field] = [...(merged[field] ?? []), ...labels];
      }
    }
  }
  return merged;
}

// Sound label -> when a real speaker would make it. The sounds guideline is composed
// from the hints of whichever labels survived steering, so the LLM only ever reads
// usage advice for sounds it's allowed to make. Labels sharing a hint (the laugh
// family) collapse to one clause; labels without an entry fall back to the generic
// sentence. Keyed by label, not NonverbalOptions field, so it's provider-agnostic.
const SOUND_USAGE_HINTS: Record<string, string> = {
  laugh: 'a laugh at something obviously funny',
  laughing: 'a laugh at something obviously funny',
  chuckle: 'a chuckle at something subtly humorous',
  chuckling: 'a chuckle at something subtly humorous',
  giggle: 'a chuckle at something subtly humorous',
  sigh: 'a sigh when commiserating',
  sighing: 'a sigh when commiserating',
  inhale: 'a sharp inhale before a big reveal',
  gasping: 'a gasp at a sudden shock or reveal',
  'lip-smack': 'a lip-smack or tongue-click as a tiny beat of thought',
  'tongue-click': 'a lip-smack or tongue-click as a tiny beat of thought',
  tsk: 'a tsk for mock-disapproval',
  'clear throat': 'a clear-throat when shifting to a new step or topic',
  groaning: 'a groan at a groan-worthy pun or an unwelcome chore',
  yawning: 'a yawn when tiredness itself is the topic',
  sobbing: 'a sob reserved for real heartbreak',
};

/** The sparing-use guideline, illustrated only with the allowed sounds. */
function soundGuidance(sounds: string[]): string {
  const hints: string[] = [];
  for (const sound of sounds) {
    const hint = SOUND_USAGE_HINTS[sound];
    if (hint && !hints.includes(hint)) hints.push(hint);
  }
  let line = 'Non-verbal sounds: use one only where the moment genuinely earns it';
  if (hints.length) line += ' — ' + hints.join(', ');
  return line + '. Most turns have none; never repeat the same sound twice in a row.';
}

/**
 * Render a {@link SpeechSteeringOptions} into delivery guidelines for `provider`.
 *
 * Only fields that change the default produce output, so an empty object adds nothing on
 * top of the base template. Disabled sounds never appear here: {@link llmInstructions}
 * filters them out of the advertised vocabulary, so the only sound guidance left is how
 * sparingly to use what remains.
 */
export function steeringInstructions(provider: string, steering: SpeechSteeringOptions): string {
  const lines: string[] = [];

  // sound guidance only when steering actually removes part of the vocabulary:
  // the explicit all-on forms (true, an empty object) must render identically to
  // omitting the key, and all-off leaves nothing to guide
  if (steeringRemoved(NONVERBAL_SOUND_LABELS, provider, steering).size) {
    const allowed = allowedSounds(provider, steering);
    if (allowed.length) lines.push(soundGuidance(allowed));
  }

  if (steering.disfluencies !== undefined) {
    lines.push(
      steering.disfluencies
        ? 'Sprinkle in natural fillers (um, uh) and openers (oh, well, so), ' +
            'zero to two per turn, never mechanical.'
        : 'No fillers (um, uh). Sound composed and fluent.',
    );
  }

  if (steering.pace !== undefined && steering.pace !== 'normal') {
    lines.push(`Keep a ${steering.pace} overall speaking pace.`);
  }

  if (!lines.length) return '';
  return 'Delivery guidelines:\n' + lines.map((line) => `- ${line}`).join('\n');
}

// Hard per-provider chunking defaults (characters). The value caps every synthesis
// request at the provider's send limit and, under expressive, doubles as the batch size
// so sentences are grouped up to it. Providers absent here are uncapped and always emit
// per sentence.
const MAX_INPUT_LEN: Record<string, number> = {
  inworld: 900,
  cartesia: 400,
  // well under xAI's 15,000-char request limit; sized as an expressive batch
  // target (https://docs.x.ai/developers/model-capabilities/audio/text-to-speech)
  xai: 1000,
  // fishaudio is deliberately absent: its markers are sentence-scoped (every sentence
  // carries its own [very EMOTION]), so per-sentence emission loses no steering and keeps
  // time-to-first-audio low
};

/** The max text chunk length for a provider, or `undefined` if unlimited. */
export function maxInputLen(provider: string): number | undefined {
  return MAX_INPUT_LEN[provider];
}

/**
 * How much text an expressive turn batches before emitting, in characters — roughly two
 * sentences.
 *
 * Deliberately far below the providers' request caps. The cap is a transport limit
 * (400–1000 chars); using it as the batch target means a typical reply never reaches it,
 * so nothing is emitted while the LLM streams and the whole turn is synthesized in one
 * request once generation ends — time-to-first-audio becomes "wait for the full
 * completion". Batching a couple of sentences is all continuous prosody needs.
 */
const EXPRESSIVE_BATCH_LEN = 200;

/**
 * Minimum length of the first chunk of an expressive turn — the tokenizer's per-sentence
 * default, so the opening sentence is sent the moment it is complete.
 *
 * Batching starts from the second chunk, which keeps prosody continuous over the body of
 * the turn while leaving time-to-first-audio identical to a non-expressive turn.
 */
const EXPRESSIVE_FIRST_CHUNK_LEN = 20;

/**
 * Default sentence tokenizer for a provider's streamed TTS input.
 *
 * The provider's hard max chunk length caps every emitted token. When `expressive` is set,
 * it also raises the *minimum* to {@link EXPRESSIVE_BATCH_LEN} so a couple of consecutive
 * sentences ride one request, keeping prosody continuous across the turn; otherwise tokens
 * emit per sentence (the unchanged default). Providers with no configured limit are
 * uncapped and stay per-sentence even under expressive — Fish Audio's markers are
 * sentence-scoped, so batching would cost time-to-first-audio and buy no steering.
 */
export function sentenceTokenizer(
  provider: string,
  options: { expressive: boolean },
): SentenceTokenizer {
  const maxLen = MAX_INPUT_LEN[provider];
  const batching = options.expressive && maxLen !== undefined;
  return new tokenizeBasic.SentenceTokenizer({
    maxTokenLength: maxLen,
    // the batch target is independent of the cap; clamped so it can never exceed it
    minTokenLength: batching ? Math.min(EXPRESSIVE_BATCH_LEN, maxLen!) : undefined,
    firstTokenLength: batching ? EXPRESSIVE_FIRST_CHUNK_LEN : undefined,
    // markup only exists in the stream when expressive is active; xml-aware
    // tokenization would otherwise hold streaming on a stray "<" in plain text
    xmlAware: options.expressive,
  });
}

const EXPR_ATTR_RE = /([\w-]+)\s*=\s*"([^"]*)"/g;
// every marker pattern captures the space before it as "pre" so dedupRemovalSpace can
// drop it when the marker vanishes from between two spaces
// any <expr ...> or <expr .../> tag (open or self-closing)
const EXPR_OPEN_RE = new RegExp(LEADING_WS + '<expr\\b(?<attrs>[^>]*?)/?\\s*>', 'g');
const EXPR_CLOSE_RE = new RegExp(LEADING_WS + '</expr\\s*>', 'g');
// self-closing markers only (the trailing / is required)
const EXPR_SELF_RE = new RegExp(LEADING_WS + '<expr\\b(?<attrs>[^>]*?)/\\s*>', 'g');
// a wrapping marker (prosody/spell) and its span; non-greedy, instructed not to nest.
// The `(?<!/)` is load-bearing: Cartesia's prosody markers are self-closing point
// controls, so without it `<expr type="prosody" label="slow"/>` reads as an *opening*
// tag whose span runs to the next `</expr>` — swallowing every marker in between. A
// `<expr type="spell">` caught that way is discarded, and the confirmation code it
// wrapped is spoken as a word instead of spelled out.
const EXPR_WRAP_RE = new RegExp(
  LEADING_WS +
    '<expr\\b(?=[^>]*type="(?:prosody|spell)")(?<attrs>[^>]*?)(?<!/)>(?<inner>.*?)</expr\\s*>',
  'gs',
);
// a non-wrapping type the LLM forgot to self-close (normalizeMarkup fixes these)
const EXPR_UNCLOSED_RE = /(<expr\b(?=[^>]*type="(?:expression|break|sound)")[^>]*[^/>\s])\s*>/g;

// expr sound labels that differ from xAI's native cue names
const XAI_SOUND_ALIASES: Record<string, string> = { breathe: 'breath' };

// expr sound labels that differ from Fish's native marker names (other providers
// advertise "laugh"/"chuckle", so a hallucinated one still lowers to a sound Fish renders)
const FISHAUDIO_SOUND_ALIASES: Record<string, string> = {
  laugh: 'laughing',
  chuckle: 'chuckling',
  sigh: 'sighing',
  gasp: 'gasping',
  groan: 'groaning',
  yawn: 'yawning',
  sob: 'sobbing',
  cry: 'sobbing',
};

// Cartesia prosody labels -> native point controls (coarse steps of the numeric ratios)
const CARTESIA_PROSODY: Record<string, string> = {
  slow: '<speed ratio="0.85"/>',
  fast: '<speed ratio="1.2"/>',
  soft: '<volume ratio="0.9"/>',
  loud: '<volume ratio="1.3"/>',
};

function exprAttrs(attrs: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of attrs.matchAll(EXPR_ATTR_RE)) {
    out[match[1]!] = match[2]!;
  }
  return out;
}

/**
 * Strip expr markers and collect (type, label) pairs, in document order.
 *
 * The generic {@link extractAndStrip} pass can't produce the right ExpressiveTag for expr
 * (its type would be the literal tag name `expr` and its value the first quoted attribute,
 * i.e. the marker type), so expr gets this dedicated pre-pass. A prosody wrapper's inner
 * words stay in the clean text — only the delimiters are removed — which also keeps
 * streaming safe when an open/close pair is split across chunks.
 */
function splitExpr(text: string): [string, ExpressiveTag[]] {
  if (!text.includes('<expr') && !text.includes('</expr')) {
    return [text, []];
  }

  const tags: ExpressiveTag[] = [];

  let clean = replaceWithGroups(text, EXPR_OPEN_RE, ({ groups, match, offset, source }) => {
    const attrs = exprAttrs(groups.attrs ?? '');
    tags.push({ type: attrs.type ?? '', value: attrs.label ?? '' });
    return dedupRemovalSpace(groups.pre ?? '', '', source, offset + match.length);
  });
  clean = replaceWithGroups(clean, EXPR_CLOSE_RE, ({ groups, match, offset, source }) =>
    dedupRemovalSpace(groups.pre ?? '', '', source, offset + match.length),
  );
  return [clean, tags];
}

/**
 * Lower expr markers to the framework-standard / native tags for `provider`.
 *
 * The output still flows through the existing per-provider conversions in
 * {@link convertMarkup} (e.g. `<sound value="X"/>` -> `[X]` for Inworld/xAI), so this only
 * has to translate expr into those intermediate tags. A type the provider doesn't support
 * (its instructions never advertise it, so it's a hallucination) is dropped from the audio
 * path — the words survive, the marker never leaks.
 */
function convertExpr(provider: string, text: string): string {
  if (!text.includes('<expr') && !text.includes('</expr')) {
    return text;
  }

  const wrap = (attrsRaw: string, inner: string): string => {
    const attrs = exprAttrs(attrsRaw);
    const markerType = attrs.type ?? '';
    const label = (attrs.label ?? '').trim().toLowerCase();
    if (markerType === 'spell') {
      return provider === 'cartesia' ? `<spell>${inner}</spell>` : inner;
    }
    // prosody: native wrapping tags exist only for xAI
    if (provider === 'xai') {
      const native = label.replace(/ /g, '-');
      if (XAI_WRAPPING.includes(native)) {
        return `<${native}>${inner}</${native}>`;
      }
      return inner;
    }
    if (provider === 'inworld') {
      // not advertised for Inworld; salvage a stray one as a delivery hint
      return `<expression value="${label}"/>${inner}`;
    }
    if (provider === 'cartesia') {
      // wrapping form of the point controls: apply before the span
      return (CARTESIA_PROSODY[label] ?? '') + inner;
    }
    if (provider === 'fishaudio') {
      if (label === 'emphasis') {
        return `<emphasis>${inner}</emphasis>`;
      }
      // tone controls are prefix markers: [whispering] steers the words after it
      if (FISHAUDIO_TONES.includes(label)) {
        return `[${label}] ${inner}`;
      }
      return inner;
    }
    return inner;
  };

  // a marker the provider doesn't support lowers to "" — dedupRemovalSpace keeps its
  // removal from leaving two spaces behind (this text is the transcript when
  // useTtsAlignedTranscript is on)
  let out = replaceWithGroups(text, EXPR_WRAP_RE, ({ groups, match, offset, source }) =>
    dedupRemovalSpace(
      groups.pre ?? '',
      wrap(groups.attrs ?? '', groups.inner ?? ''),
      source,
      offset + match.length,
    ),
  );

  const self = (attrsRaw: string): string => {
    const attrs = exprAttrs(attrsRaw);
    const markerType = attrs.type ?? '';
    let label = attrs.label ?? '';
    if (markerType === 'expression') {
      if (provider === 'cartesia') {
        // Cartesia's discrete emotion vocabulary (instructions list it)
        return `<emotion value="${label}"/>`;
      }
      if (provider === 'inworld' || provider === 'fishaudio') {
        return `<expression value="${label}"/>`;
      }
      return ''; // xAI has no free-form delivery descriptions
    }
    if (markerType === 'sound') {
      if (provider === 'cartesia') {
        return ''; // no non-verbal sound support
      }
      if (provider === 'xai') {
        label = XAI_SOUND_ALIASES[label.toLowerCase()] ?? label;
      }
      if (provider === 'fishaudio') {
        label = FISHAUDIO_SOUND_ALIASES[label.toLowerCase()] ?? label;
      }
      return `<sound value="${label}"/>`;
    }
    if (markerType === 'break') {
      return `<break time="${label}"/>`;
    }
    if (markerType === 'prosody' && provider === 'cartesia') {
      // Cartesia prosody is a self-closing point control (speed/volume)
      return CARTESIA_PROSODY[label.trim().toLowerCase()] ?? '';
    }
    if (markerType === 'prosody' && provider === 'fishaudio') {
      // tones are taught as wrapping, but Fish's native form is a prefix marker anyway
      // — salvage a self-closing one as-is
      const tone = label.trim().toLowerCase();
      return FISHAUDIO_TONES.includes(tone) ? `[${tone}]` : '';
    }
    return '';
  };

  out = replaceWithGroups(out, EXPR_SELF_RE, ({ groups, match, offset, source }) =>
    dedupRemovalSpace(groups.pre ?? '', self(groups.attrs ?? ''), source, offset + match.length),
  );
  // a stray unpaired expr tag (e.g. a prosody wrapper split across stream chunks)
  // must never reach the TTS as literal text — drop the delimiters, keep the words
  out = replaceWithGroups(out, EXPR_OPEN_RE, ({ groups, match, offset, source }) =>
    dedupRemovalSpace(groups.pre ?? '', '', source, offset + match.length),
  );
  out = replaceWithGroups(out, EXPR_CLOSE_RE, ({ groups, match, offset, source }) =>
    dedupRemovalSpace(groups.pre ?? '', '', source, offset + match.length),
  );
  return out;
}

// Providers with an expr instruction block. Kept as a set so "does this voice speak
// markup?" is answerable without rendering the block — the answer is needed on the
// per-segment speech path, and the blocks run to several kilobytes.
const MARKUP_DIALECTS = new Set(['cartesia', 'inworld', 'xai', 'fishaudio']);

/**
 * Whether `provider` has an expr instruction block, i.e. whether expressive can do
 * anything for it. Allocation-free: prefer this over testing
 * `llmInstructions(...) !== undefined`.
 */
export function hasMarkupDialect(provider: string): boolean {
  return MARKUP_DIALECTS.has(provider);
}

/**
 * LLM instruction text for a TTS provider, or `undefined` when it has no markup dialect.
 *
 * Each markup-capable provider gets its own expr instruction block — shared marker syntax,
 * but only the types and label vocabularies that provider actually supports;
 * {@link convertMarkup} lowers the markers to native syntax. Expr is the only dialect the
 * LLM is ever taught. When `steering` disables a non-verbal sound, its labels (and any
 * example demonstrating them) are omitted from the block entirely rather than advertised
 * and then revoked.
 */
export function llmInstructions(
  provider: string,
  steering?: SpeechSteeringOptions,
): string | undefined {
  if (!hasMarkupDialect(provider)) {
    return undefined;
  }
  if (provider === 'cartesia') {
    return CARTESIA_EXPR_LLM_INSTRUCTIONS;
  }
  if (provider === 'inworld') {
    return inworldExprLlmInstructions(allowedSounds(provider, steering));
  }
  if (provider === 'xai') {
    return xaiExprLlmInstructions(
      allowedSounds(provider, steering),
      allowedProsody(provider, steering),
    );
  }
  if (provider === 'fishaudio') {
    return fishaudioExprLlmInstructions(
      allowedSounds(provider, steering),
      steering?.disfluencies ?? true,
    );
  }
  return undefined;
}

// Per-provider native XML tag names. Membership also marks a provider as markup-capable
// (see normalizeMarkup / convertMarkup); the LLM only ever writes expr markers, so these
// names exist to lower expr onto and to catch hallucinated natives.
const PROVIDER_MARKUP: Record<string, string[]> = {
  cartesia: CARTESIA_TAGS,
  inworld: INWORLD_TAGS,
  xai: XAI_TAGS,
  // fish's native dialect is square brackets, produced only by convertMarkup for the TTS;
  // these names exist to catch hallucinated XML natives in transcripts
  fishaudio: FISHAUDIO_TAGS,
};

// Union of every provider's XML tag names — used by the transcript sinks to strip markup
// without knowing which provider produced it (see TranscriptMarkupStripper).
const ALL_MARKUP_TAGS: string[] = [...new Set(Object.values(PROVIDER_MARKUP).flat())].sort();

// Tags whose payload lives in an attribute rather than in their content. They are
// self-closing by definition, but models do write `<expression value="warm">words</expression>`
// (which is exactly why `normalizeMarkup` repairs that shape) — and the transcript sinks
// strip the raw text, before any repair. Without this, the wrapped sentence would be
// recorded as the delivery label and published as `lk.expression`.
const ATTRIBUTE_MARKUP_TAGS: ReadonlySet<string> = new Set([
  'expression',
  'emotion',
  'sound',
  'break',
  'speed',
  'volume',
]);

/**
 * Strip the union of every provider's expressive XML markup (provider-agnostic).
 *
 * The transcript sinks strip downstream, where the originating TTS/provider is no longer
 * in scope, so they remove every provider's XML tags at once: expr markers (all the LLM is
 * ever taught) plus every native tag name, so a hallucinated native tag is stripped rather
 * than leaked.
 *
 * Square-bracket spans are *not* stripped: the LLM only writes expr, so brackets in its
 * output are prose (a `[text](url)` link) that a strip would mangle. Provider-native
 * brackets never arrive here — {@link dropBracketCues} removes them at their source.
 */
export function splitAllMarkup(text: string): [string, ExpressiveTag[]] {
  // every markup shape is angle-bracketed, so text without "<" cannot contain any. The
  // sinks call this per streamed chunk and expressive is off by default, making this the
  // overwhelmingly common case — skip the tag-union scan entirely
  if (!text.includes('<')) {
    return [text, []];
  }

  const [withoutExpr, exprTags] = splitExpr(text);
  const [clean, rawTags] = extractAndStrip(withoutExpr, ALL_MARKUP_TAGS, ATTRIBUTE_MARKUP_TAGS);
  return [clean, [...exprTags, ...rawTags.map(([type, value]) => ({ type, value }))]];
}

/** {@link splitAllMarkup} returning only the clean text (tags discarded). */
export function stripAllMarkup(text: string): string {
  return splitAllMarkup(text)[0];
}

/**
 * Strip only the `<expr/>` dialect, leaving all other markup untouched.
 *
 * Unlike {@link stripAllMarkup}, provider-native tags survive (both leave square-bracket
 * spans alone).
 */
export function stripExprMarkup(text: string): string {
  return splitExpr(text)[0];
}

/**
 * Build the `lk.expression` transcription attribute from stripped markup tags.
 *
 * Surfaces a segment's leading delivery/emotion (`expression` for Inworld/xAI, `emotion`
 * for Cartesia) as `{"expression": ..., "mood": ...}`: the provider's own words, plus the
 * mood they normalize to, so a client can drive UI off a fixed enum without
 * reimplementing the matching. Returns `undefined` when no such tag was present.
 */
export function expressionAttribute(tags: ExpressiveTag[]): Record<string, string> | undefined {
  const expression = tags.find((t) => t.type === 'expression' || t.type === 'emotion')?.value;
  if (expression === undefined) {
    return undefined;
  }
  const payload = { expression, mood: matchMood(expression) };
  return { [ATTRIBUTE_TRANSCRIPTION_EXPRESSION]: JSON.stringify(payload) };
}

/**
 * Stateful, provider-agnostic markup stripper for one transcript segment.
 *
 * Fed text chunk-by-chunk, it returns the user-visible text and accumulates the stripped
 * tags. A tag-shaped trailing fragment (a partial `<...` arriving split across chunks) is
 * held back until it closes, so a tag straddling a chunk boundary is never emitted
 * half-stripped. Shared by the transcript sinks (room output + transcript synchronizer) so
 * stripping and expression extraction stay identical across them.
 */
export class TranscriptMarkupStripper {
  #buf = '';
  #tags: ExpressiveTag[] = [];
  #seamAfterStrip = false;
  #emittedVisible = false;

  /**
   * Strip `text`, record its tags, and keep a removed tag from doubling a space.
   *
   * {@link splitAllMarkup} drops one of the two spaces a removed tag sat between, but only
   * when it can see both. Trailing whitespace is therefore held back rather than emitted,
   * so a tag opening the *next* chunk is still stripped against the space before it;
   * `final` releases the held whitespace at segment end.
   */
  #consume(text: string, final: boolean): string {
    let input = text;
    if (this.#seamAfterStrip && (input[0] === ' ' || input[0] === '\t')) {
      // a tag was stripped right at the held whitespace: collapse that whitespace with the
      // run following it, leaving the single separator the words need
      input = input[0] + input.slice(1).replace(/^[ \t]+/, '');
    }

    const [clean, tags] = splitAllMarkup(input);
    this.#tags.push(...tags);

    const trimmed = trimEndSpaces(clean);
    const held = final ? '' : clean.slice(trimmed.length);
    this.#buf = held;
    // the held whitespace only abuts a removal when this chunk *ended* on a tag; a tag
    // stripped earlier in the chunk leaves whitespace the LLM itself wrote, which is
    // passed through rather than collapsed
    this.#seamAfterStrip = tags.length > 0 && held.length > 0 && trimEndSpaces(input).endsWith('>');

    let emit = clean.slice(0, clean.length - held.length);
    if (!this.#emittedVisible) {
      // A marker opening the segment leaves the space that followed it behind: the dedup
      // drops the whitespace *before* a removed tag, and at position 0 there is none. The
      // instructions ask for a leading expression marker, so this is the common case —
      // without this the transcript would open with a space on nearly every turn.
      emit = emit.replace(/^\s+/, '');
    }
    if (emit) this.#emittedVisible = true;
    return emit;
  }

  #hasOpenTag(): boolean {
    // hold a tag-shaped trailing "<" (partial XML tag) so "3 < 5" isn't stalled. An
    // unclosed "[" is not held: brackets aren't markup here, and stalling on one would
    // delay every markdown link until its "]" arrives
    const lastLt = this.#buf.lastIndexOf('<');
    if (lastLt > this.#buf.lastIndexOf('>')) {
      const nxt = this.#buf.slice(lastLt + 1, lastLt + 2);
      if (nxt === '' || nxt === '/' || /[a-z]/i.test(nxt)) {
        return true;
      }
    }
    return false;
  }

  /** Feed a chunk; return the clean text ready to emit (may be empty). */
  push(text: string): string {
    this.#buf += text;
    if (this.#hasOpenTag()) {
      return '';
    }
    return this.#consume(this.#buf, false);
  }

  /** Drain any buffered text at segment end; return the remaining clean text. */
  flush(): string {
    if (!this.#buf) {
      return '';
    }
    return this.#consume(this.#buf, true);
  }

  /** The markup tags stripped so far, in document order. */
  get tags(): ExpressiveTag[] {
    return this.#tags;
  }

  /** The `lk.expression` attribute for the tags stripped so far, if any. */
  expressionAttribute(): Record<string, string> | undefined {
    return expressionAttribute(this.#tags);
  }
}

function trimEndSpaces(value: string): string {
  return value.replace(/[ \t]+$/, '');
}

const BRACKET_SPAN_RE = /\[[^\]]*\]/g;
// cap on how long an unclosed "[" is held before it is released as plain text
const MAX_HELD_CHARS = 256;

/** A copy of `token` carrying `text`, keeping the alignment metadata. */
function retext(token: TimedString, text: string): TimedString {
  return createTimedString({
    text,
    startTime: token.startTime,
    endTime: token.endTime,
    confidence: token.confidence,
    startTimeOffset: token.startTimeOffset,
    speakerId: token.speakerId,
  });
}

/**
 * Remove bracket cues from TTS-aligned tokens, keeping the survivors' timings.
 *
 * `useTtsAlignedTranscript` makes the provider's alignment of the text it was sent the
 * transcript, and that text is post-{@link convertMarkup}, so it carries native
 * `[laugh]`/`[speak calmly]` cues as words the agent never spoke. Every bracket span goes:
 * the provider reads them all as cues, so none is ever audio, and markdown links are
 * already gone (`filterMarkdown` runs on TTS input by default).
 *
 * Alignment arrives in messages finer-grained than a cue — often one word at a time — so
 * `held` carries the tail of an unclosed span across calls; pass the same array every time
 * and call once more with `final: true` at end of stream to release it.
 */
export function dropBracketCues(
  tokens: TimedString[],
  held: TimedString[],
  options: { final?: boolean } = {},
): TimedString[] {
  const all = [...held, ...tokens];
  held.length = 0;
  const text = all.map((t) => t.text).join('');
  if (!text.includes('[')) {
    return all;
  }

  const dropped = new Set<number>();
  for (const match of text.matchAll(BRACKET_SPAN_RE)) {
    let start = match.index!;
    let end = start + match[0].length;
    // take one of the spaces the cue sat between, so it leaves a single separator
    if (start > 0 && text[start - 1] === ' ' && (end === text.length || text[end] === ' ')) {
      start -= 1;
    } else if (start === 0 && end < text.length && text[end] === ' ') {
      end += 1;
    }
    for (let i = start; i < end; i++) dropped.add(i);
  }

  // hold from an unclosed "[" so a cue straddling messages is still judged as a whole;
  // past MAX_HELD_CHARS give up, since a lone bracket must not stall the transcript
  let holdFrom = text.length;
  if (!options.final) {
    const openAt = text.lastIndexOf('[');
    if (openAt > text.lastIndexOf(']') && text.length - openAt <= MAX_HELD_CHARS) {
      holdFrom = openAt;
    }
  }

  const out: TimedString[] = [];
  let pos = 0;
  for (const token of all) {
    let emit = '';
    let keep = '';
    for (let i = 0; i < token.text.length; i++) {
      const idx = pos + i;
      const char = token.text[i]!;
      if (idx >= holdFrom) {
        keep += char;
      } else if (!dropped.has(idx)) {
        emit += char;
      }
    }
    pos += token.text.length;
    if (emit) out.push(emit === token.text ? token : retext(token, emit));
    if (keep) held.push(keep === token.text ? token : retext(token, keep));
  }
  return out;
}

const SELF_CLOSING_TAGS: Record<string, string[]> = {
  cartesia: ['emotion', 'speed', 'volume', 'break'],
  inworld: ['expression', 'sound', 'break'],
  fishaudio: ['expression', 'sound', 'break'],
};

/**
 * Fix common LLM markup mistakes for a provider.
 *
 * Closes opening tags that should be self-closing (e.g. the LLM writes
 * `<expression value="happy">` instead of `<expression value="happy"/>` — or
 * `<expr type="sound" label="laugh">` instead of `<expr type="sound" label="laugh"/>`).
 */
export function normalizeMarkup(provider: string, text: string): string {
  let out = text;
  if (provider in PROVIDER_MARKUP) {
    out = out.replace(EXPR_UNCLOSED_RE, '$1/>');
  }
  const tags = SELF_CLOSING_TAGS[provider];
  if (!tags) {
    return out;
  }
  const pattern = new RegExp(`<(${tags.map(escapeRegExp).join('|')})\\b([^>]*[^/])\\s*>`, 'g');
  return out.replace(pattern, '<$1$2/>');
}

/** Convert framework-standard markup to a provider's native syntax. */
export function convertMarkup(provider: string, text: string): string {
  let out = text;
  if (provider in PROVIDER_MARKUP) {
    // lower expr markers first; the per-provider conversions below then handle the
    // intermediate framework-standard tags they produce
    out = convertExpr(provider, out);
  }
  if (provider === 'inworld' || provider === 'xai') {
    // <sound value="X"/> -> [X] (and <expression value="X"/> -> [X]); for xAI this turns
    // inline sounds into its native brackets while emotion/prosody stay <..>
    out = convertExpressionTags(out);
  }
  if (provider === 'xai') {
    // xAI has no <break>; map it to its native [pause]/[long-pause]
    out = out.replace(XAI_BREAK_RE, xaiBreakToBracket);
  }
  if (provider === 'fishaudio') {
    // <expression value="X"/> -> [very X] first (the intensified form steers harder),
    // then the generic pass lowers the remaining <sound value="X"/> -> [X]
    out = out.replace(FISHAUDIO_EXPRESSION_RE, fishaudioExpressionToBracket);
    out = convertExpressionTags(out);
    out = out.replace(FISHAUDIO_BREAK_RE, fishaudioBreakToBracket);
    // Fish's per-word stress marker: <emphasis>word</emphasis> -> [emphasis] word
    out = out.replace(FISHAUDIO_EMPHASIS_RE, (_m, inner: string) => `[emphasis] ${inner.trim()}`);
  }
  // <break> is otherwise passed through unchanged: Inworld accepts it as native SSML.
  return out;
}
