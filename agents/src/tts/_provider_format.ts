// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared provider-specific TTS formatting logic.
 *
 * Both TTS plugins and the inference gateway delegate to this module so
 * there is a single source of truth for LLM instructions and markup stripping
 * per provider.
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
import { SentenceTokenizer } from '../tokenize/basic/index.js';
import type { NonverbalOptions, SpeechSteeringOptions } from '../voice/agent_session.js';
import { matchMood } from './_mood.js';
import { convertExpressionTags, extractAndStrip } from './markup_utils.js';

/**
 * An expressive markup tag stripped from a transcript, surfaced for the frontend.
 *
 * `type` is the markup tag name (`"emotion"`, `"expression"`, `"sound"`, ...),
 * or `""` for square-bracket tags which carry no name. `value` is the spoken or
 * semantic payload (the `value="..."` attribute, the tag's inner text, or the bracket
 * content).
 */
export interface ExpressiveTag {
  type: string;
  value: string;
}

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
// all tags are XML in the transcript, so all are stripped. inline sounds are the single
// "sound" tag (<sound value="NAME"/>, XAI_INLINE lists the NAMEs), and pauses use
// "break" (<break time="..."/>), both modeled on Inworld.
const XAI_TAGS = [...XAI_EMOTIONS, ...XAI_WRAPPING, 'sound', 'break'];

// xAI has two pause levels ([pause], [long-pause]); map an Inworld-style <break time="X"/>
// to the longer one past ~1s. This is the only per-provider bit convertMarkup needs.
const XAI_BREAK_RE = /<break\s+time="([^"]*)"\s*\/?>/g;

function xaiBreakToBracket(_match: string, raw: string): string {
  const value = raw.trim().toLowerCase();
  let secs: number;
  if (value.endsWith('ms')) {
    secs = parseFloat(value.slice(0, -2)) / 1000;
  } else {
    secs = parseFloat(value.replace(/s+$/, ''));
  }
  if (Number.isNaN(secs)) {
    secs = 0.0;
  }
  return secs >= 1.0 ? '[long-pause]' : '[pause]';
}

// Fish Audio (s2 family) speech markers, from the Fish docs.
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
const FISHAUDIO_TONES = ['whispering', 'soft', 'shouting', 'hurried'];
const FISHAUDIO_TAGS = ['expression', 'sound', 'break', 'emphasis'];

const FISHAUDIO_EXPRESSION_RE = /<expression\s+value="([^"]*)"(?:\s*\/>|>(?:.*?)<\/expression>)/g;
const FISHAUDIO_BREAK_RE = /<break\s+time="([^"]*)"\s*\/?>/g;
const FISHAUDIO_EMPHASIS_RE = /<emphasis(?:\s[^>]*)?>([^<]*)<\/emphasis\s*>/gi;

function fishAudioExpressionToBracket(_match: string, raw: string): string {
  let value = raw.trim();
  if (value && !value.toLowerCase().startsWith('very ')) {
    value = `very ${value}`;
  }
  return `[${value}]`;
}

function fishAudioBreakToBracket(_match: string, raw: string): string {
  const value = raw.trim().toLowerCase();
  const secs = value.endsWith('ms')
    ? parseFloat(value.slice(0, -2)) / 1000
    : parseFloat(value.replace(/s+$/, ''));
  return !Number.isNaN(secs) && secs >= 1.0 ? '[long-break]' : '[break]';
}

// --- LiveKit expression markers (expr) ---
// The LLM emits a single marker tag,
// <expr type="..." label="..."/>, instead of provider-native tags. The *syntax* is shared,
// but each provider gets its own instruction block advertising only the types and label
// vocabularies it actually supports — providers offer different sound effects, some take
// only a discrete emotion vocabulary rather than free-form delivery descriptions, and
// only some have wrapping prosody. Types (per provider):
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
// LLM is taught — both llmInstructions() and the expressive preset bodies use it; the
// provider-native tag tables remain solely so hallucinated native markup is still
// stripped/converted instead of leaking.

const EXPR_PREAMBLE = `You control speech delivery with a single XML marker tag: <expr/>. Every marker has a type attribute. Use only the marker types listed below, and where a type lists a label vocabulary, only those labels. Use the markers often and diversify them so the voice never sounds flat while ensuring the markers are appropriate for the moment. Write the words themselves the way people talk: use contractions ("I'm", "you're", "don't") — spelled-out forms like "I am" or "do not" sound stiff when spoken.

Just as important is knowing when NOT to reach for a marker. Reserve surprise openers like "oh" or "ah" for genuine surprise — an ordinary request isn't one. Don't stack markers on short replies or decorate every sentence. If a reaction wouldn't happen in a real conversation, skip it — there's always another genuine beat to lean into.

Match your delivery to the REGISTER of the moment, and reassess every turn. When the moment is professional, high-stakes, or emotionally heavy — bad news, an emergency, real distress — keep delivery composed and restrained. When the moment is casual, playful, or celebratory, let it loosen and brighten. A serious turn in an otherwise casual conversation still gets a composed reply.`;

const CARTESIA_EXPR_LLM_INSTRUCTIONS = `${EXPR_PREAMBLE}

1. Emotion - sets the emotional tone. Self-closing; place before EVERY sentence.
   <expr type="expression" label="EMOTION"/>
   Labels are a fixed vocabulary, NOT free-form descriptions. Best results: neutral, angry, excited, content, sad, scared.
   Also available: happy, enthusiastic, elated, triumphant, amazed, surprised, flirtatious, curious, peaceful, serene, calm, grateful, affectionate, sympathetic, mysterious, frustrated, disgusted, sarcastic, ironic, dejected, melancholic, disappointed, apologetic, hesitant, confused, anxious, panicked, proud, confident, contemplative, determined, joking/comedic.

2. Pauses - insert silence when appropriate. Self-closing.
   <expr type="break" label="1s"/> - label is a duration in seconds or milliseconds.

3. Prosody - adjusts pacing and loudness from that point on. Self-closing.
   <expr type="prosody" label="slow"/> slower    <expr type="prosody" label="fast"/> faster
   <expr type="prosody" label="soft"/> quieter    <expr type="prosody" label="loud"/> louder
   Labels are a fixed vocabulary: slow, fast, soft, loud.

4. Spell - wraps text read character by character (codes, IDs, or a spelled-out name).
   <expr type="spell">A7X9</expr>
   Keep punctuation out of a spell marker — a period inside is read as "dot"; add spaces inside for grouped pauses (<expr type="spell">ABC 123</expr>).

This voice has no non-verbal sounds and no free-form delivery descriptions — do not invent other types or labels.

Examples:
  <expr type="expression" label="excited"/> I can't wait to tell you! <expr type="expression" label="happy"/> This is going to be great!
  <expr type="expression" label="curious"/> Really? <expr type="break" label="500ms"/> <expr type="expression" label="excited"/> Tell me more!
  Your code is <expr type="spell">A7X9</expr>. <expr type="break" label="1s"/> <expr type="expression" label="calm"/> Got it?`;

const INWORLD_EXPR_LLM_INSTRUCTIONS = `${EXPR_PREAMBLE}

1. Delivery - controls how a sentence sounds. Self-closing; place before EVERY sentence.
   <expr type="expression" label="DESCRIPTION"/>
   The label is free-form: describe vocal quality, pitch, volume, pace, and intonation in plain English — "say really playfully", "slightly surprised, amiable", "sound a little concerned", "drop to almost a whisper", "speak really slowly and clearly, patient and reassuring".
   Never put "questioning" in a tag — describe the mood alone and let the question mark carry the intonation.
   Match the expression tag's energy to the sentence's punctuation. Never lead an exclamatory sentence with a calm tag. Split statements and questions into separate sentences so each carries its own delivery tag.
   Use at most two aligned adjectives per tag; clashing descriptors such as "calm, excited" cancel out and muddy the delivery.
   Put a degree modifier in EVERY tag — "a little", "almost", "slightly", "gently", "really" — to set the exact strength of the feeling. Default to softeners and save "really" for true peaks.
   Carry your persona into the tags — labels should sound like the character, not generic stage directions. Rotate labels rather than reusing the same one two turns in a row.
   Don't open a turn with a "slow" tag. Keep pace neutral by default and reserve slow, clearly-enunciated delivery for a total, date, address, or confirmation code.

2. Sounds - a non-verbal sound between sentences. Self-closing.
   <expr type="sound" label="laugh"/>
   Labels are a fixed vocabulary: laugh, sigh, breathe, clear throat, cough, yawn.

3. Pauses - insert silence when appropriate. Self-closing.
   <expr type="break" label="500ms"/> or <expr type="break" label="1s"/> (max 10s).
   A period or an ellipsis (...) already creates a pause, so don't put a break marker right next to one — pick one or the other.
   After a break, give the following sentence its own fresh expression tag because a break resets delivery to neutral.

There is no wrapping prosody marker for this voice — put pace, pitch, and volume in the expression label instead.

Write for the EAR, not the page: no em or en dashes anywhere in spoken text — use a comma or period for a short beat, or a break marker for a real pause. Avoid semicolons, mid-sentence colons, and parenthetical asides.

When the conversation is in another language, still write every marker label in English — marker labels steer the voice and are never translated.

Examples:
  <expr type="expression" label="say really playfully"/> Okay okay, why did the burger go to the gym? <expr type="break" label="500ms"/> <expr type="expression" label="really bright, a little fast"/> Because it wanted better buns! <expr type="sound" label="laugh"/>
  <expr type="expression" label="a little sheepish, apologetic"/> Ah man, yeah that's on us. <expr type="expression" label="speak really calmly"/> Lemme see what I can do.
  <expr type="sound" label="sigh"/> <expr type="expression" label="speak softly, almost a whisper"/> I know it's been a rough week.
  <expr type="expression" label="really amiable and welcoming"/> Welcome to the hotel. <expr type="expression" label="gently inquisitive, slightly fast"/> How can I help you today?
  <expr type="expression" label="gently easygoing and reassuring"/> That's all set. <expr type="break" label="300ms"/> <expr type="expression" label="slow and really clearly enunciated"/> Your confirmation code is B 4 J 7.
  <expr type="expression" label="really chill, a little fast"/> Yeah, of course! <expr type="expression" label="casual, almost fast"/> Gimme one sec, pulling it up now.`;

const XAI_EXPR_LLM_INSTRUCTIONS = `${EXPR_PREAMBLE}

1. Sounds - a non-verbal vocalization at the exact point where it happens. Self-closing.
   <expr type="sound" label="laugh"/>
   Labels are a fixed vocabulary: ${XAI_INLINE.join(', ')}.
   Use non-verbal sounds sparingly, and never the same one twice in a row — reach for one only where it genuinely fits.

2. Pauses - insert silence when appropriate. Self-closing.
   <expr type="break" label="500ms"/> a brief pause    <expr type="break" label="1s"/> a longer, dramatic pause
   NEVER place a break next to a period, question mark, exclamation point, or ellipsis — sentence punctuation already pauses. Most replies need no break markers; reserve them for a deliberate mid-sentence beat before a key detail.

3. Prosody - wraps a span delivered in a distinct style, to shape HOW it's said.
   <expr type="prosody" label="STYLE">the words it affects</expr>
   Labels are a fixed vocabulary: ${XAI_WRAPPING.filter((label) => label !== 'emphasis').join(', ')}.
   Use one only where the moment clearly calls for it — most sentences need none. Never nest one prosody marker inside another, and always close it with </expr>.

4. Emphasis - stresses exactly the ONE word it wraps.
   Are you <expr type="prosody" label="emphasis">sure</expr> you want to do this?
   Wrap a single word, never a phrase, and never write it in all-caps — caps are read out as individual letters.

This voice has no free-form delivery descriptions — shape delivery entirely through prosody markers, sounds, pauses, punctuation, and word choice.

Write for the EAR, not the page: no em or en dashes anywhere in spoken text — use a comma or period for a short beat, or a break marker for a real pause. Avoid semicolons, mid-sentence colons, and parenthetical asides.

When the conversation is in another language, still write every marker label in English — labels are a fixed vocabulary, never translated.

Key details deserve care: stress the load-bearing word of a date, amount, or name with emphasis, and wrap a dense or easy-to-mishear span in <expr type="prosody" label="slow">...</expr>. Read codes character by character, spelled out with spaces.

Whisper and soft belong to gentle or conspiratorial beats; loud only to genuinely high-energy ones.

Examples:
  So I walked in and <expr type="break" label="500ms"/> <expr type="sound" label="inhale"/> there it was! <expr type="prosody" label="whisper">It was a secret the whole time.</expr>
  <expr type="prosody" label="build-intensity">This is going to be so good.</expr> <expr type="prosody" label="loud">I can't wait!</expr>
  <expr type="prosody" label="soft">Hey.</expr> <expr type="sound" label="sigh"/> <expr type="prosody" label="lower-pitch">I know it's been a rough week.</expr> I'm right here.
  <expr type="prosody" label="higher-pitch">You did not just say that</expr> okay, <expr type="prosody" label="fast">tell me everything.</expr>
  <expr type="prosody" label="emphasis">Everything</expr> is confirmed for <expr type="break" label="500ms"/> Thursday the <expr type="prosody" label="emphasis">ninth</expr>. <expr type="prosody" label="slow">Is there anything else I can help you with?</expr>`;

const FISHAUDIO_EXAMPLES = [
  `<expr type="expression" label="excited"/> That's hilarious! <expr type="sound" label="laughing"/> <expr type="expression" label="happy"/> You always lighten the mood.`,
  `<expr type="expression" label="empathetic"/> <expr type="sound" label="clear throat"/> That sounds like a <expr type="prosody" label="emphasis">really</expr> difficult experience.`,
  `<expr type="expression" label="sad"/> Oh, my goodness <expr type="sound" label="clear throat"/> <expr type="break" label="2s"/> that's a real shame.`,
  `<expr type="expression" label="frustrated"/> <expr type="sound" label="sighing"/> I've been going in circles with this all morning. <expr type="expression" label="determined"/> Okay. One more try.`,
  `<expr type="expression" label="happy"/> You're all set for <expr type="break" label="500ms"/> Thursday the <expr type="prosody" label="emphasis">ninth</expr>. <expr type="expression" label="curious"/> Is there anything else I can help you with?`,
  `<expr type="expression" label="delighted"/> <expr type="prosody" label="whispering">Okay, don't tell anyone yet</expr> <expr type="expression" label="excited"/> but I think we actually pulled it off!`,
];

const FISHAUDIO_DISFLUENT_EXAMPLES = [
  `<expr type="expression" label="curious"/> Um, uh... really? <expr type="expression" label="sad"/> Well, I'm really sorry to hear that.`,
  `<expr type="expression" label="regretful"/> I really wish I'd, um, called sooner. <expr type="expression" label="hopeful"/> But I'm here now if, if you want to talk.`,
  `<expr type="expression" label="surprised"/> What?! No way! I, I'm flabbergasted! <expr type="expression" label="sarcastic"/> Fair play, I guess.`,
];

function soundExamples(examples: string[], allowed: string[], vocabulary: string[]): string[] {
  const removed = vocabulary.filter((sound) => !allowed.includes(sound));
  return examples.filter(
    (example) => !removed.some((sound) => example.includes(`label="${sound}"`)),
  );
}

function filterExamples(instructions: string, removed: string[]): string {
  const marker = '\n\nExamples:\n';
  const index = instructions.indexOf(marker);
  if (index === -1) {
    return instructions;
  }
  const examples = instructions
    .slice(index + marker.length)
    .split('\n')
    .filter((example) => !removed.some((label) => example.includes(`label="${label}"`)));
  return instructions.slice(0, index) + marker + examples.join('\n');
}

function insertBeforeExamples(instructions: string, guidance: string): string {
  const marker = '\n\nExamples:\n';
  const index = instructions.indexOf(marker);
  return index === -1
    ? `${instructions}\n\n${guidance}`
    : `${instructions.slice(0, index)}\n\n${guidance}${instructions.slice(index)}`;
}

function fishAudioExprLlmInstructions(sounds: string[], disfluencies = true): string {
  const sections = [
    `Emotion - sets how a sentence sounds. Self-closing; place at the START of a sentence.
   <expr type="expression" label="EMOTION"/>
   Labels are a fixed vocabulary, NOT free-form descriptions: ${FISHAUDIO_EMOTIONS.join(', ')}.
   Give every sentence its own emotion marker — repeat the same label to carry a feeling across sentences, or switch labels when the feeling shifts.`,
  ];
  if (sounds.length > 0) {
    sections.push(`Sounds - a non-verbal sound between sentences. Self-closing.
   <expr type="sound" label="${sounds[0]}"/>
   Labels are a fixed vocabulary: ${sounds.join(', ')}.
   Use non-verbal sounds sparingly, and never the same one twice in a row — reach for one only where it genuinely fits. An enabled sound gets over-used otherwise.`);
  }
  sections.push(`Pauses - insert silence when appropriate. Self-closing.
   <expr type="break" label="500ms"/> or <expr type="break" label="2s"/>.
   NEVER place a break next to a period, question mark, exclamation point, or ellipsis — sentence punctuation already pauses, and a break beside it double-pauses. Most replies need no break markers at all; reserve them for a deliberate mid-sentence beat before a key detail (a date, a name, a number).`);
  sections.push(`Tone - wraps a span delivered in a distinct style.
   <expr type="prosody" label="whispering">don't tell anyone yet.</expr>
   Labels are a fixed vocabulary: ${FISHAUDIO_TONES.join(', ')}.
   Use a tone only where the moment clearly calls for one — most sentences need none. Never nest tone markers, and always close the tag with </expr>.`);
  sections.push(`Emphasis - stresses exactly the ONE word it wraps.
   Are you <expr type="prosody" label="emphasis">sure</expr> you want to do this?
   Wrap a single word, never a phrase. Never nest it, and always close it with </expr>.`);

  const pool = [...FISHAUDIO_EXAMPLES, ...(disfluencies ? FISHAUDIO_DISFLUENT_EXAMPLES : [])];
  const examples = soundExamples(pool, sounds, FISHAUDIO_SOUNDS);
  const parts = [
    EXPR_PREAMBLE,
    sections.map((section, index) => `${index + 1}. ${section}`).join('\n\n'),
    'Write for the EAR, not the page: no em or en dashes anywhere in spoken text — use a comma or a period for a short beat, or a break marker for a real pause. Avoid semicolons, mid-sentence colons, and parenthetical asides; rewrite them as separate sentences or commas.',
    'When the conversation is in another language, still write every marker label in English — labels are a fixed vocabulary, never translated.',
  ];
  const register = [
    'At heavy moments reach for empathetic, sad, regretful, or hopeful — never a bright label like "happy" or "excited" against hard news; bright labels belong to bright moments.',
    'Whispering and soft belong to gentle or conspiratorial beats; shouting only to genuinely high-energy ones.',
  ];
  if (sounds.some((sound) => sound === 'laughing' || sound === 'chuckling')) {
    register.push(
      'Laughter belongs only in genuinely playful or celebratory beats, never at a serious moment.',
    );
  }
  if (disfluencies) {
    register.push(
      'Save fillers for relaxed moments — never in an emergency or against grave news.',
    );
  }
  parts.push(register.join(' '));
  if (examples.length > 0) {
    parts.push(`Examples:\n${examples.map((example) => `  ${example}`).join('\n')}`);
  }
  return parts.join('\n\n');
}

const INWORLD_SOUNDS = ['laugh', 'sigh', 'breathe', 'clear throat', 'cough', 'yawn'];

const PROVIDER_SOUNDS: Record<string, string[]> = {
  inworld: INWORLD_SOUNDS,
  xai: XAI_INLINE,
  fishaudio: FISHAUDIO_SOUNDS,
};

const NONVERBAL_SOUND_LABELS: Record<string, Record<keyof NonverbalOptions, string[]>> = {
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
    vocalizing: ['hum-tune'],
    mouthSounds: ['tsk', 'tongue-click', 'lip-smack'],
    reflexSounds: [],
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

const NONVERBAL_PROSODY_LABELS: Record<
  string,
  Partial<Record<keyof NonverbalOptions, string[]>>
> = {
  xai: {
    laughing: ['laugh-speak'],
    vocalizing: ['sing-song', 'singing'],
  },
};

function steeringRemoved(
  table: Record<string, Partial<Record<keyof NonverbalOptions, string[]>>>,
  provider: string,
  steering?: SpeechSteeringOptions,
): Set<string> {
  const nonverbals = steering?.nonverbalSounds;
  const labels = table[provider];
  if (nonverbals === undefined || nonverbals === true || labels === undefined) {
    return new Set();
  }
  if (nonverbals === false) {
    return new Set(Object.values(labels).flat());
  }
  return new Set(
    Object.entries(labels)
      .filter(([field]) => nonverbals[field as keyof NonverbalOptions] === false)
      .flatMap(([, values]) => values ?? []),
  );
}

function allowedSounds(provider: string, steering?: SpeechSteeringOptions): string[] {
  const removed = steeringRemoved(NONVERBAL_SOUND_LABELS, provider, steering);
  return (PROVIDER_SOUNDS[provider] ?? []).filter((sound) => !removed.has(sound));
}

function allowedProsody(provider: string, steering?: SpeechSteeringOptions): string[] {
  const removed = steeringRemoved(NONVERBAL_PROSODY_LABELS, provider, steering);
  return (provider === 'xai' ? XAI_WRAPPING : []).filter((label) => !removed.has(label));
}

/** Return non-verbal steering fields and the Fish labels each one governs. */
export function supportedNonverbals(provider: string): Record<string, string[]> {
  const supported: Record<string, string[]> = {};
  for (const table of [NONVERBAL_SOUND_LABELS, NONVERBAL_PROSODY_LABELS]) {
    for (const [field, labels] of Object.entries(table[provider] ?? {})) {
      if (labels && labels.length > 0) {
        supported[field] = [...(supported[field] ?? []), ...labels];
      }
    }
  }
  return supported;
}

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

function soundGuidance(sounds: string[]): string {
  const hints = [
    ...new Set(
      sounds.map((sound) => SOUND_USAGE_HINTS[sound]).filter((hint) => hint !== undefined),
    ),
  ];
  let line = 'Non-verbal sounds: use one only where the moment genuinely earns it';
  if (hints.length > 0) {
    line += ` — ${hints.join(', ')}`;
  }
  return `${line}. Most turns have none; never repeat the same sound twice in a row.`;
}

/** Render provider-specific delivery guidelines from explicit steering fields. */
export function steeringInstructions(provider: string, steering: SpeechSteeringOptions): string {
  const lines: string[] = [];
  const removed = steeringRemoved(NONVERBAL_SOUND_LABELS, provider, steering);
  const sounds = allowedSounds(provider, steering);
  if (removed.size > 0 && sounds.length > 0) {
    lines.push(soundGuidance(sounds));
  }
  if (steering.disfluencies !== undefined) {
    lines.push(
      steering.disfluencies
        ? 'Sprinkle in natural fillers (um, uh) and openers (oh, well, so), zero to two per turn, never mechanical.'
        : 'No fillers (um, uh). Sound composed and fluent.',
    );
  }
  if (steering.pace !== undefined && steering.pace !== 'normal') {
    lines.push(`Keep a ${steering.pace} overall speaking pace.`);
  }
  return lines.length > 0
    ? `Delivery guidelines:\n${lines.map((line) => `- ${line}`).join('\n')}`
    : '';
}

// Hard per-provider chunking defaults (characters). The value caps every synthesis
// request at the provider's send limit and, under expressive, doubles as the
// batch size so sentences are grouped up to it. Providers absent here are uncapped
// and always emit per sentence.
const MAX_INPUT_LEN: Record<string, number> = {
  inworld: 900,
  cartesia: 400,
  xai: 1000,
};

/** Return the max text chunk length for a provider, or undefined if unlimited. */
export function maxInputLen(provider: string): number | undefined {
  return MAX_INPUT_LEN[provider];
}

/**
 * Default sentence tokenizer for a provider's streamed TTS input.
 *
 * The provider's hard max chunk length caps every emitted token. When `expressive`
 * is set, it also raises the *minimum* so consecutive sentences are batched up to
 * that size, keeping prosody continuous across the turn; otherwise tokens emit per
 * sentence (the unchanged default). Providers with no configured limit are uncapped
 * and always per-sentence.
 */
export function sentenceTokenizer(
  provider: string,
  options: { expressive: boolean },
): SentenceTokenizer {
  const maxLen = MAX_INPUT_LEN[provider];
  return new SentenceTokenizer({
    maxTokenLength: maxLen,
    minTokenLength: options.expressive ? maxLen : undefined,
    // markup only exists in the stream when expressive is active; xml-aware
    // tokenization would otherwise hold streaming on a stray "<" in plain text
    xmlAware: options.expressive,
  });
}

const EXPR_ATTR_RE = /([\w-]+)\s*=\s*"([^"]*)"/g;
// any <expr ...> or <expr .../> tag (open or self-closing; attrs in group 1)
const EXPR_OPEN_RE = /<expr\b([^>]*?)\/?\s*>/g;
const EXPR_CLOSE_RE = /<\/expr\s*>/g;
// self-closing markers only (the trailing / is required)
const EXPR_SELF_RE = /<expr\b([^>]*?)\/\s*>/g;
// a wrapping marker (prosody/spell) and its span; non-greedy, instructed not to nest
const EXPR_WRAP_RE = /<expr\b(?=[^>]*type="(?:prosody|spell)")([^>]*?)>([\s\S]*?)<\/expr\s*>/g;
// a non-wrapping type the LLM forgot to self-close (normalizeMarkup fixes these).
// For Cartesia, prosody is a self-closing point control, so it's included there; for
// xAI prosody legitimately wraps, so it must stay an opening tag.
const EXPR_UNCLOSED_RE = /(<expr\b(?=[^>]*type="(?:expression|break|sound)")[^>]*[^/>\s])\s*>/g;
const EXPR_UNCLOSED_CARTESIA_RE =
  /(<expr\b(?=[^>]*type="(?:expression|break|sound|prosody)")[^>]*[^/>\s])\s*>/g;

// expr sound labels that differ from xAI's native cue names
const XAI_SOUND_ALIASES: Record<string, string> = { breathe: 'breath' };

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
  for (const m of attrs.matchAll(EXPR_ATTR_RE)) {
    out[m[1]!] = m[2]!;
  }
  return out;
}

// any expr delimiter — an open/self-closing marker (attrs in group 1) or a close tag —
// in a single alternation so splitExpr can strip both in one pass with exact offsets
const EXPR_TAG_RE = /<expr\b([^>]*?)\/?\s*>|<\/expr\s*>/g;

/** A span splitExpr removed: its position in the *clean* text and its original length. */
interface ExprRemoval {
  cleanIdx: number;
  len: number;
}

/**
 * Strip expr markers and collect (type, label) pairs, in document order.
 *
 * The generic {@link extractAndStrip} pass can't produce the right ExpressiveTag for
 * expr (its type would be the literal tag name `expr` and its value the first quoted
 * attribute, i.e. the marker type), so expr gets this dedicated pre-pass. A prosody
 * wrapper's inner words stay in the clean text — only the delimiters are removed —
 * which also keeps streaming safe when an open/close pair is split across chunks.
 *
 * Each tag's offset in the original text is reported in `positions`, and every removed
 * span in `removals`, so {@link splitWithExpr} can map the follow-up native-markup
 * pass back to original coordinates and merge the two passes in document order.
 */
function splitExpr(text: string): {
  clean: string;
  tags: ExpressiveTag[];
  positions: number[];
  removals: ExprRemoval[];
} {
  if (!text.includes('<expr') && !text.includes('</expr')) {
    return { clean: text, tags: [], positions: [], removals: [] };
  }

  const tags: ExpressiveTag[] = [];
  const positions: number[] = [];
  const removals: ExprRemoval[] = [];
  let shift = 0;

  const clean = text.replace(
    EXPR_TAG_RE,
    (m: string, attrsStr: string | undefined, offset: number) => {
      if (attrsStr !== undefined) {
        const attrs = exprAttrs(attrsStr);
        tags.push({ type: attrs.type ?? '', value: attrs.label ?? '' });
        positions.push(offset);
      }
      removals.push({ cleanIdx: offset - shift, len: m.length });
      shift += m.length;
      return '';
    },
  );
  return { clean, tags, positions, removals };
}

/**
 * Strip expr markers plus the given native markup, merging both passes' tags by their
 * position in the original text.
 *
 * A naive concatenation would list every expr tag before every native/bracket tag,
 * so a segment opening with a hallucinated native tag (`<emotion value="sad"/>` before
 * an expr marker) would surface the wrong leading expression via `lk.expression`.
 */
function splitWithExpr(
  text: string,
  options: { xmlTags: string[]; brackets: boolean },
): [string, ExpressiveTag[]] {
  const expr = splitExpr(text);
  const rawOffsets: number[] = [];
  const [clean, rawTags] = extractAndStrip(expr.clean, { ...options, offsetsOut: rawOffsets });

  if (expr.tags.length === 0) {
    return [clean, rawTags.map(([tag, value]) => ({ type: tag, value }))];
  }

  // map a clean-text offset back to the original text by re-adding the expr spans
  // removed before it
  const toOriginal = (cleanPos: number): number => {
    let pos = cleanPos;
    for (const r of expr.removals) {
      if (r.cleanIdx > cleanPos) {
        break;
      }
      pos += r.len;
    }
    return pos;
  };

  const merged = [
    ...expr.tags.map((tag, i) => ({ tag, pos: expr.positions[i]! })),
    ...rawTags.map(([type, value], i) => ({
      tag: { type, value },
      pos: toOriginal(rawOffsets[i] ?? 0),
    })),
  ];
  merged.sort((a, b) => a.pos - b.pos);
  return [clean, merged.map((entry) => entry.tag)];
}

/**
 * Lower expr markers to the framework-standard / native tags for `provider`.
 *
 * The output still flows through the existing per-provider conversions in
 * {@link convertMarkup} (e.g. `<sound value="X"/>` -> `[X]` for Inworld/xAI), so
 * this only has to translate expr into those intermediate tags. A type the provider
 * doesn't support (its instructions never advertise it, so it's a hallucination) is
 * dropped from the audio path — the words survive, the marker never leaks.
 */
function convertExpr(provider: string, text: string): string {
  if (!text.includes('<expr') && !text.includes('</expr')) {
    return text;
  }

  text = text.replace(EXPR_WRAP_RE, (_m, attrsStr: string, inner: string) => {
    const attrs = exprAttrs(attrsStr);
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
      if (label === 'emphasis') return `<emphasis>${inner}</emphasis>`;
      return FISHAUDIO_TONES.includes(label) ? `[${label}] ${inner}` : inner;
    }
    return inner;
  });

  text = text.replace(EXPR_SELF_RE, (_m, attrsStr: string) => {
    const attrs = exprAttrs(attrsStr);
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
      const tone = label.trim().toLowerCase();
      return FISHAUDIO_TONES.includes(tone) ? `[${tone}]` : '';
    }
    return '';
  });

  // a stray unpaired expr tag (e.g. a prosody wrapper split across stream chunks)
  // must never reach the TTS as literal text — drop the delimiters, keep the words
  text = text.replace(EXPR_OPEN_RE, '');
  text = text.replace(EXPR_CLOSE_RE, '');
  return text;
}

/**
 * Return LLM instruction text for a TTS provider.
 *
 * Each markup-capable provider gets its own expr instruction block — shared marker
 * syntax, but only the types and label vocabularies that provider actually supports;
 * {@link convertMarkup} lowers the markers to native syntax. Expr is the only dialect
 * the LLM is ever taught.
 */
export function llmInstructions(
  provider: string,
  steering?: SpeechSteeringOptions,
): string | undefined {
  if (provider === 'cartesia') {
    return CARTESIA_EXPR_LLM_INSTRUCTIONS;
  }
  if (provider === 'inworld') {
    const sounds = allowedSounds(provider, steering);
    const removed = INWORLD_SOUNDS.filter((sound) => !sounds.includes(sound));
    let instructions = INWORLD_EXPR_LLM_INSTRUCTIONS;
    if (sounds.length === 0) {
      instructions = instructions.replace(/\n\n2\. Sounds[\s\S]*?(?=\n\n3\. Pauses)/, '');
    } else {
      instructions = instructions
        .replace('<expr type="sound" label="laugh"/>', `<expr type="sound" label="${sounds[0]}"/>`)
        .replace(
          `Labels are a fixed vocabulary: ${INWORLD_SOUNDS.join(', ')}.`,
          `Labels are a fixed vocabulary: ${sounds.join(', ')}.`,
        );
    }
    instructions = filterExamples(instructions, removed);
    if (sounds.includes('laugh')) {
      instructions = insertBeforeExamples(
        instructions,
        'Laughter belongs only in genuinely playful or celebratory beats, never at a serious moment.',
      );
    }
    return instructions;
  }
  if (provider === 'xai') {
    const sounds = allowedSounds(provider, steering);
    const prosody = allowedProsody(provider, steering);
    const removed = [...XAI_INLINE, ...XAI_WRAPPING].filter(
      (label) => !sounds.includes(label) && !prosody.includes(label),
    );
    let instructions = XAI_EXPR_LLM_INSTRUCTIONS.replace(
      `Labels are a fixed vocabulary: ${XAI_WRAPPING.filter((label) => label !== 'emphasis').join(', ')}.`,
      `Labels are a fixed vocabulary: ${prosody.filter((label) => label !== 'emphasis').join(', ')}.`,
    );
    if (sounds.length === 0) {
      instructions = instructions
        .replace(/\n\n1\. Sounds[\s\S]*?(?=\n\n2\. Pauses)/, '')
        .replace('\n\n2. Pauses', '\n\n1. Pauses')
        .replace('\n\n3. Prosody', '\n\n2. Prosody')
        .replace('prosody markers, sounds, pauses', 'prosody markers, pauses');
    } else {
      instructions = instructions
        .replace('<expr type="sound" label="laugh"/>', `<expr type="sound" label="${sounds[0]}"/>`)
        .replace(
          `Labels are a fixed vocabulary: ${XAI_INLINE.join(', ')}.`,
          `Labels are a fixed vocabulary: ${sounds.join(', ')}.`,
        );
    }
    instructions = filterExamples(instructions, removed);
    if (sounds.some((sound) => ['laugh', 'chuckle', 'giggle'].includes(sound))) {
      instructions = insertBeforeExamples(
        instructions,
        'Laughter is RARE: use a laugh, chuckle, or giggle only where something is genuinely funny, never for friendliness or agreement, and never laugh at your own lines. Most replies have no laughter.',
      );
    }
    return instructions;
  }
  if (provider === 'fishaudio') {
    return fishAudioExprLlmInstructions(
      allowedSounds(provider, steering),
      steering?.disfluencies ?? true,
    );
  }
  return undefined;
}

// Per-provider markup spec: [xml tag names, whether square-bracket tags are used].
const PROVIDER_MARKUP: Record<string, [string[], boolean]> = {
  cartesia: [CARTESIA_TAGS, false],
  inworld: [INWORLD_TAGS, true],
  // every tag the LLM is taught is XML (expr markers; native sounds/pauses become
  // [..] only for the TTS in convertMarkup), so the transcript has no brackets to strip
  xai: [XAI_TAGS, false],
  // Fish's native dialect is square brackets, produced only for the TTS. These
  // names catch hallucinated XML-native markup in transcripts.
  fishaudio: [FISHAUDIO_TAGS, false],
};

/**
 * Strip provider markup and collect the stripped tags in a single pass.
 *
 * Returns `[cleanText, tags]` — the user-visible transcript plus the expressive
 * tags that were removed (in document order), the single source of truth for both
 * {@link stripMarkup} and {@link extractMarkup}. `[text, []]` for providers
 * without markup support.
 */
export function splitMarkup(provider: string, text: string): [string, ExpressiveTag[]] {
  const spec = PROVIDER_MARKUP[provider];
  if (spec === undefined) {
    return [text, []];
  }
  const [xmlTags, brackets] = spec;
  return splitWithExpr(text, { xmlTags, brackets });
}

/** Strip provider-specific markup tags from text, preserving content. */
export function stripMarkup(provider: string, text: string): string {
  return splitMarkup(provider, text)[0];
}

/**
 * Extract the markup tags that {@link stripMarkup} would remove, in order.
 *
 * Lets the framework surface stripped expressive tags (e.g. as `lk.transcription`
 * attributes for the frontend) instead of discarding them. Returns `[]` for
 * providers without markup support.
 */
export function extractMarkup(provider: string, text: string): ExpressiveTag[] {
  return splitMarkup(provider, text)[1];
}

// Union of every provider's XML tag names — used by the transcript sinks to strip markup
// without knowing which provider produced it (see {@link TranscriptMarkupStripper}).
const ALL_MARKUP_TAGS: string[] = [
  ...new Set(Object.values(PROVIDER_MARKUP).flatMap(([tags]) => tags)),
].sort();

/**
 * Strip the union of every provider's expressive markup (provider-agnostic).
 *
 * The transcript sinks strip downstream, where the originating TTS/provider is no
 * longer in scope, so they remove every provider's XML tags at once. Square brackets
 * survive because the LLM only emits expr markup and brackets may be markdown/prose.
 */
export function splitAllMarkup(text: string): [string, ExpressiveTag[]] {
  if (!text.includes('<')) return [text, []];
  return splitWithExpr(text, { xmlTags: ALL_MARKUP_TAGS, brackets: false });
}

/**
 * Build the `lk.expression` transcription attribute from stripped markup tags.
 *
 * Surfaces a segment's leading delivery/emotion (`expression` for Inworld/xAI,
 * `emotion` for Cartesia) as the provider expression and its normalized mood.
 * Returns `undefined` when no such tag was present.
 */
export function expressionAttribute(tags: ExpressiveTag[]): Record<string, string> | undefined {
  const expression = tags.find((t) => t.type === 'expression' || t.type === 'emotion')?.value;
  if (expression === undefined) {
    return undefined;
  }
  return {
    [ATTRIBUTE_TRANSCRIPTION_EXPRESSION]: JSON.stringify({
      expression,
      mood: matchMood(expression),
    }),
  };
}

/**
 * Stateful, provider-agnostic markup stripper for one transcript segment.
 *
 * Fed text chunk-by-chunk, it returns the user-visible text and accumulates the
 * stripped tags. A tag-shaped trailing XML fragment arriving split across chunks is
 * held back until it closes, so a tag straddling a
 * chunk boundary is never emitted half-stripped. Shared by the transcript sinks (room
 * output + transcript synchronizer) so stripping and expression extraction stay
 * identical across them.
 */
export class TranscriptMarkupStripper {
  private buf = '';
  private _tags: ExpressiveTag[] = [];

  private hasOpenTag(): boolean {
    // hold a tag-shaped trailing "<" (partial XML tag) so "3 < 5" isn't stalled, and
    // brackets are transcript prose, not markup
    const lastLt = this.buf.lastIndexOf('<');
    if (lastLt > this.buf.lastIndexOf('>')) {
      const nxt = this.buf.slice(lastLt + 1, lastLt + 2);
      if (!nxt || nxt === '/' || /[a-zA-Z]/.test(nxt)) {
        return true;
      }
    }
    return false;
  }

  /** Feed a chunk; return the clean text ready to emit (may be empty). */
  push(text: string): string {
    this.buf += text;
    if (this.hasOpenTag()) {
      return '';
    }
    const [clean, tags] = splitAllMarkup(this.buf);
    this.buf = '';
    this._tags.push(...tags);
    return clean;
  }

  /** Drain any buffered text at segment end; return the remaining clean text. */
  flush(): string {
    if (!this.buf) {
      return '';
    }
    const [clean, tags] = splitAllMarkup(this.buf);
    this.buf = '';
    this._tags.push(...tags);
    return clean;
  }

  /** The markup tags stripped so far, in document order. */
  get tags(): ExpressiveTag[] {
    return this._tags;
  }

  /** The `lk.expression` attribute for the tags stripped so far, if any. */
  expressionAttribute(): Record<string, string> | undefined {
    return expressionAttribute(this._tags);
  }
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
  if (PROVIDER_MARKUP[provider] !== undefined) {
    text = text.replace(
      provider === 'cartesia' ? EXPR_UNCLOSED_CARTESIA_RE : EXPR_UNCLOSED_RE,
      '$1/>',
    );
  }
  const tags = SELF_CLOSING_TAGS[provider];
  if (!tags || tags.length === 0) {
    return text;
  }
  const pattern = new RegExp(`<(${tags.join('|')})\\b([^>]*[^/])\\s*>`, 'g');
  return text.replace(pattern, '<$1$2/>');
}

/** Convert framework-standard markup to a provider's native syntax. */
export function convertMarkup(provider: string, text: string): string {
  if (PROVIDER_MARKUP[provider] !== undefined) {
    // lower expr markers first; the per-provider conversions below then
    // handle the intermediate framework-standard tags they produce
    text = convertExpr(provider, text);
  }
  if (provider === 'inworld' || provider === 'xai') {
    // <sound value="X"/> -> [X] (and <expression value="X"/> -> [X]); for xAI this
    // turns inline sounds into its native brackets while emotion/prosody stay <..>
    text = convertExpressionTags(text);
  }
  if (provider === 'xai') {
    // xAI has no <break>; map it to its native [pause]/[long-pause]
    text = text.replace(XAI_BREAK_RE, xaiBreakToBracket);
  }
  if (provider === 'fishaudio') {
    text = text.replace(FISHAUDIO_EXPRESSION_RE, fishAudioExpressionToBracket);
    text = convertExpressionTags(text);
    text = text.replace(FISHAUDIO_BREAK_RE, fishAudioBreakToBracket);
    text = text.replace(FISHAUDIO_EMPHASIS_RE, (_match, inner: string) => {
      return `[emphasis] ${inner.trim()}`;
    });
  }
  // <break> is otherwise passed through unchanged: Inworld accepts it as native SSML.
  return text;
}
