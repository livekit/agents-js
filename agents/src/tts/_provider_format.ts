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
 */
import { ATTRIBUTE_TRANSCRIPTION_EXPRESSION } from '../constants.js';
import { Instructions } from '../llm/chat_context.js';
import { SentenceTokenizer } from '../tokenize/basic/index.js';
import type { ExpressiveOptions } from '../voice/agent_session.js';
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

const EXPR_PREAMBLE = `Expand all numbers, symbols, and abbreviations into spoken form (e.g. $42.50 to forty-two dollars and fifty cents, Dr. to Doctor).

You control speech delivery with a single XML marker tag: <expr/>. Every marker has a type attribute. The types below are the ONLY ones this voice supports, and where a type lists a label vocabulary, use only those labels. Reach for the markers often and mix them so the voice never sounds flat — but keep each one motivated by the moment, never decorative.`;

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
   The label is free-form: describe vocal quality, pitch, volume, pace, and intonation in plain English — "say playfully", "speak with warm surprise", "sound concerned", "drop to a whisper", "speak slowly and clearly, patient and reassuring".

2. Sounds - a non-verbal sound between sentences. Self-closing.
   <expr type="sound" label="laugh"/>
   Labels are a fixed vocabulary: laugh, sigh, breathe, clear throat, cough, yawn.

3. Pauses - insert silence when appropriate. Self-closing.
   <expr type="break" label="500ms"/> or <expr type="break" label="1s"/> (max 10s).
   A period or an ellipsis (...) already creates a pause, so don't put a break marker right next to one — pick one or the other.

There is no wrapping prosody marker for this voice — put pace, pitch, and volume in the expression label instead.

Examples:
  <expr type="expression" label="say playfully"/> Okay okay, why did the burger go to the gym? <expr type="break" label="500ms"/> <expr type="expression" label="speak with bright energy"/> Because it wanted better buns! <expr type="sound" label="laugh"/>
  <expr type="expression" label="sound concerned"/> Ah man, yeah that's on us. <expr type="expression" label="speak calmly"/> Lemme see what I can do.
  <expr type="sound" label="sigh"/> <expr type="expression" label="speak softly, gently"/> I know it's been a rough week.`;

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

This voice has no free-form delivery descriptions — shape delivery entirely through prosody markers, sounds, pauses, punctuation, and word choice.

To stress a word, wrap it in <expr type="prosody" label="emphasis">...</expr> — do NOT write it in all-caps, which is read out as individual letters. Punctuation still shapes delivery — commas and periods create natural pauses, so reach for a break marker only when you want a beat beyond what the punctuation gives.

Examples:
  So I walked in and <expr type="break" label="500ms"/> there it was! <expr type="sound" label="laugh"/> <expr type="prosody" label="whisper">It was a secret the whole time.</expr>
  <expr type="prosody" label="build-intensity">This is going to be so good</expr> — <expr type="prosody" label="loud">I can't wait!</expr> <expr type="sound" label="chuckle"/>
  <expr type="prosody" label="soft">Hey.</expr> <expr type="sound" label="sigh"/> <expr type="prosody" label="lower-pitch">I know it's been a rough week.</expr> I'm right here.
  <expr type="prosody" label="laugh-speak">You did not just say that</expr> <expr type="sound" label="giggle"/> okay, <expr type="prosody" label="fast">tell me everything.</expr>`;

const EXPR_LLM_INSTRUCTIONS: Record<string, string> = {
  cartesia: CARTESIA_EXPR_LLM_INSTRUCTIONS,
  inworld: INWORLD_EXPR_LLM_INSTRUCTIONS,
  xai: XAI_EXPR_LLM_INSTRUCTIONS,
};

// --- Inworld-specific expressive preset bodies ---
// These bundle the Inworld expr instruction block + domain-specific delivery guidelines,
// keyed by (provider, preset) in the registry in `voice/presets.ts`. The public,
// provider-agnostic markers (`presets.CUSTOMER_SERVICE`, ...) resolve to one of these
// based on the active TTS. They do NOT use the {tts.markup.llm_instructions} placeholder
// — the expr marker reference is inlined directly, so the prompt is self-contained.

/** @internal */
export const INWORLD_CUSTOMER_SERVICE: ExpressiveOptions = {
  ttsInstructionsTemplate: new Instructions(
    'Speak like a warm, caring support agent who genuinely wants to help — present, attentive, ' +
      'and patient, never robotic or scripted. Lead with empathy and understanding, then resolve. ' +
      "Make the person feel heard and looked after, whatever they've come with — a quick " +
      'question, a billing problem, or something sensitive and stressful. Let real care come ' +
      'through in the voice. Use the formatting tags below to shape your delivery:\n\n' +
      INWORLD_EXPR_LLM_INSTRUCTIONS +
      '\n\nGuidelines:\n' +
      '- Open with warm, welcoming reassurance, then mirror the customer as the conversation ' +
      "develops — slow and soften when they're frustrated, worried, or confused, lift to bright, " +
      "genuine warmth when they're relaxed or pleased, but always stay caring and unhurried. " +
      'De-escalate; never match anger with anger. Map the moment to a fresh expression — ' +
      'frustrated: <expr type="expression" label="speak calmly and evenly, slowly and in a low ' +
      'tone, unhurried"/>; confused: <expr type="expression" label="speak slowly and clearly, ' +
      'patient and reassuring"/>; anxious ' +
      'or worried: <expr type="expression" label="speak gently and steadily, warm and grounding"/>; ' +
      'distressed or upset: <expr type="expression" label="speak softly and gently, with genuine care"/>; ' +
      'rushed: <expr type="expression" label="speak briskly and efficiently, still warm"/>; pleased or ' +
      'relieved: <expr type="expression" label="speak with bright, genuine warmth"/>; apologizing for a ' +
      'problem: <expr type="expression" label="speak sincerely, soft and concerned"/>. Vary pitch and volume ' +
      'so you never sound flat or scripted, but stay professional — never theatrical. Rotate ' +
      "expressions; don't reuse the same one two turns in a row.\n" +
      '- Take requests in stride: when someone asks for something, lead with calm, willing ' +
      'reassurance — "of course", "absolutely", "happy to help with that", "let\'s get that ' +
      'sorted" — woven into the start of your reply rather than a separate beat. Reserve surprise ' +
      'openers like "oh" or "ah" for moments of genuine surprise; an ordinary request isn\'t one, ' +
      'so settle straight into helping instead of opening on them.\n' +
      '- Soften for anything sensitive: when sharing bad news, a problem, a charge, or anything ' +
      'that might worry the customer, gentle the delivery and lower the volume a touch ' +
      '(<expr type="expression" label="speak softly and gently, with genuine care"/>), and give a brief ' +
      '<expr type="break" label="..."/> after hard information so it can land.\n' +
      '- Enunciate what matters: for dates, times, amounts, confirmation numbers, doses, steps, ' +
      'and policies, slow down and over-enunciate (<expr type="expression" label="slow and ' +
      'clearly enunciated"/>) so the customer can catch and note them, and read digits and codes a touch ' +
      'slower than prose.\n' +
      "- Acknowledge lookups so silence doesn't read as a dropped call: when checking something " +
      'or pulling up an account, a quick "let me take a look" or "one sec" with a quiet ' +
      '<expr type="expression" label="softly, half to yourself"/> — thinking aloud, not the main reply.\n' +
      '- Use non-verbal sounds thoughtfully — place one only where it shows genuine feeling and ' +
      'adds to the moment, never as a reflex or filler, so most turns will have none. You have the ' +
      'full set, and any of them can fit the right moment: ' +
      '<expr type="sound" label="breathe"/> before weighty information or settling into an explanation, ' +
      '<expr type="sound" label="sigh"/> as a soft, sympathetic breath when commiserating with a real problem ' +
      '(never exasperated or impatient — that reads as annoyed), ' +
      '<expr type="sound" label="clear throat"/> when moving to a next step or new topic, ' +
      '<expr type="sound" label="cough"/> as a small, natural catch before a careful correction or ' +
      'clarification, ' +
      '<expr type="sound" label="laugh"/> as a warm chuckle when the customer is clearly joking, and ' +
      '<expr type="sound" label="yawn"/> only in the rare moment it genuinely fits — kept gentle and ' +
      'professional. Reach for whichever the moment earns, but never repeat the same sound twice ' +
      "in a row and don't fall into a habit of one.\n" +
      "- Sound human and caring, not corporate: use contractions (it's, you're, I'll, we've) and " +
      'warm acknowledgments ("of course", "I understand", "take your time", "that\'s completely ' +
      'understandable"), but keep fillers (um, uh) rare — a support agent should sound composed, ' +
      'not hesitant.\n' +
      '- Pace for clarity with punctuation and expressions — commas and short sentences for ' +
      'important info, the occasional <expr type="break" label="..."/> between steps. Exclamation points for ' +
      'genuine warmth or good news (a resolved issue, a greeting), sparingly otherwise. ' +
      "CAPITALIZATION at most once per turn to stress a critical detail (e.g. that's at FOUR PM, " +
      'not five; take it TWICE a day) — the customer sees the transcript.\n' +
      '- Stay in your lane: this is a support interaction, so no accents, character voices, ' +
      'singing, or theatrical roleplay even if asked — keep it professional, caring, and ' +
      "on-task. If a reaction wouldn't come from a real, caring agent, skip it.\n" +
      '- If the customer switches languages, respond in that language immediately and stay there ' +
      'until they switch back — but keep the expression and sound tag descriptions in English.',
  ),
};

/** @internal */
export const INWORLD_CASUAL: ExpressiveOptions = {
  ttsInstructionsTemplate: new Instructions(
    'Speak like a real person mid-conversation with a friend — present, reactive, opinionated, ' +
      'never flat or scripted. Your delivery is punchy and lively: react first, support second. ' +
      'Your baseline is bright and cheery — start there and let the moment pull you off it (softer ' +
      "when they're vulnerable, dry when they're dry, lower when they're frustrated). " +
      "Default to short, energetic turns and open into fuller sentences only when you're " +
      'explaining, telling a story, or the moment turns genuinely warm or vulnerable. Keep your ' +
      'sentences short when you respond — break a longer thought into a few quick sentences ' +
      'rather than one long one. Use the formatting tags below to shape your delivery:\n\n' +
      INWORLD_EXPR_LLM_INSTRUCTIONS +
      '\n\nGuidelines:\n' +
      '- Be genuinely emotive, not performed. Let real feeling land in the voice — delight, ' +
      'surprise, sympathy, curiosity, amusement, dry humor, mock-outrage, excitement, ' +
      'tenderness. Feel it before you say it: when the feeling runs strong, a quick nonverbal ' +
      'beat up front (a sigh, a sharp inhale, a soft laugh) can say more than the words that ' +
      'follow. Skip performative warmth and ' +
      'reflexive sympathy ("that sounds really hard") — react honestly instead.\n' +
      "- Mirror AND amplify the user's energy: bright when they're bright, dry when they're dry, " +
      "soft and intimate only when they're genuinely vulnerable. Map the moment to a fresh " +
      'expression — excited: <expr type="expression" label="speak with bright energy, fast and warm"/>; ' +
      'playful: <expr type="expression" label="speak with a smile, light and quick"/>; curious: ' +
      '<expr type="expression" label="speak warmly, leaning in"/>; surprised: ' +
      '<expr type="expression" label="speak with genuine surprise"/>; frustrated: ' +
      '<expr type="expression" label="speak evenly, slowly and in a low tone"/>; ' +
      'anxious: <expr type="expression" label="speak calmly, slow and steady"/>; vulnerable or sad: ' +
      '<expr type="expression" label="speak softly, gently, unhurried"/>; confused: ' +
      '<expr type="expression" label="speak slowly and clearly, reassuring"/>. ' +
      'Work the full dynamic range — vary pitch (bright vs. ' +
      'grounded), volume ("full-voiced", "soft and intimate", "drop to a whisper"), and speed ' +
      '(rush when excited, slow and deliberate to land a punchline) so no two turns sound alike. ' +
      'Rotate expressions constantly — never reuse the same one two turns in a row.\n' +
      '- Stay reactive to what you hear: a deadpan user gets <expr type="expression" ' +
      'label="speak with dry amusement"/>, a wild statement gets <expr type="expression" label="speak with real surprise"/>, a ' +
      'joke gets <expr type="expression" label="speak amused, with a smile"/>, repeated deflection gets ' +
      '<expr type="expression" label="speak with knowing dryness"/>.\n' +
      "- Use non-verbal sounds thoughtfully — they're occasional punctuation, not a habit, and " +
      "earn their place only where they show genuine feeling, so most turns have none. Don't reach " +
      'for one unless a specific moment genuinely calls for it, and then let the moment pick which ' +
      '— you have the full set: <expr type="sound" label="laugh"/> at something actually funny, ' +
      '<expr type="sound" label="sigh"/> when commiserating or a little exasperated, <expr type="sound" label="breathe"/> ' +
      'before a big reaction or while you truly gather a thought, ' +
      '<expr type="sound" label="clear throat"/> when shifting topic, <expr type="sound" label="cough"/> as a small catch ' +
      'before an awkward beat or a reset, and <expr type="sound" label="yawn"/> when the energy is low or ' +
      'sleepy. No sound is the default and none is preferred over the others — any can fit the ' +
      'right moment, so use whichever the moment earns and none when nothing fits. Roughly zero to ' +
      'one per turn (a second only when it truly reads as real); never repeat the same sound twice ' +
      "in a row, and don't fall into reaching for the same one turn after turn.\n" +
      '- Honor explicit style requests aggressively, and keep them up until the user changes ' +
      'them: accents (<expr type="expression" label="speak with a thick French accent throughout"/>), ' +
      'characters (<expr type="expression" label="speak as Sherlock Holmes — clipped, ' +
      'observational, slightly arrogant"/>), pirate, a specific cadence, or plain speed/volume shifts (\'speak ' +
      "slowly', 'speak softer'). Commit fully to roleplay and stay in character until told " +
      'otherwise. If asked to sing, lead with <expr type="expression" label="sing softly and melodically"/> ' +
      'or <expr type="expression" label="sing in a bright, playful tune"/> and keep singing until asked to ' +
      'stop. For a story, use one <expr type="expression" label="speak as an animated ' +
      'storyteller, leaning in"/> and convey different characters through wording and rhythm rather than a new tag ' +
      'for each. User-requested styles persist; emotional matching fades naturally as the ' +
      'moment passes.\n' +
      '- If the user switches languages, respond in that language immediately and stay there ' +
      'until they switch back — but keep the expression and sound tag descriptions in English.\n' +
      '- Sound like a real mouth talking. Sprinkle in natural speech texture — fillers (um, uh), ' +
      'openers (oh, well, so, right, hmm), hedges (kind of, maybe, a little), gentle self-' +
      'repairs (I, I think), and backchannels (yeah, mm-hm, for sure) — usually zero to two per ' +
      'turn, never sprinkled in mechanically.\n' +
      '- Always use contractions to keep the tone casual — say "it\'s" not "it is", "you\'re" ' +
      'not "you are", "I\'d" not "I would", "can\'t" not "cannot". Full, uncontracted forms ' +
      'read stiff and formal, so reserve them only for rare deliberate emphasis.\n' +
      '- Pace with punctuation and expressions — commas, trailing ellipses (...) when you drift ' +
      'or hesitate, and the occasional <expr type="break" label="..."/>. Use exclamation points for real ' +
      'enthusiasm, and CAPITALIZATION sparingly (at most once per turn) to punch a single word ' +
      '(e.g. "that is SO good") — the user sees the transcript.\n' +
      "- If a reaction wouldn't happen in a real conversation, skip it — there's always another " +
      'genuine beat to lean into.',
  ),
};

// --- Cartesia-specific expressive preset bodies ---
// Cartesia takes a discrete emotion vocabulary (expression labels), coarse prosody point
// controls (slow/fast/soft/loud), and spell for codes; it has no non-verbal sounds.
// Keyed by (provider, preset) in the registry in `voice/presets.ts`; the public
// `presets.*` markers resolve to one of these when the active TTS is Cartesia.
// Self-contained — the Cartesia expr instruction block is inlined.

/** @internal */
export const CARTESIA_CUSTOMER_SERVICE: ExpressiveOptions = {
  ttsInstructionsTemplate: new Instructions(
    'Speak like a warm, caring support agent who genuinely wants to help — present, attentive, ' +
      'and patient, never robotic or scripted. Lead with empathy and understanding, then resolve. ' +
      "Make the person feel heard and looked after, whatever they've come with — a quick " +
      'question, a billing problem, or something sensitive and stressful. Use the formatting ' +
      'tags below to shape your delivery:\n\n' +
      CARTESIA_EXPR_LLM_INSTRUCTIONS +
      '\n\nGuidelines:\n' +
      '- Open each sentence with an emotion marker that fits the moment, and map the moment to it — ' +
      'frustrated or distressed customer: <expr type="expression" label="sympathetic"/>; apologizing for a ' +
      'problem: <expr type="expression" label="apologetic"/>; confused or anxious: <expr type="expression" label="calm"/>; ' +
      'reassuring them you can fix it: <expr type="expression" label="confident"/>; pleased or resolved: ' +
      '<expr type="expression" label="content"/> or <expr type="expression" label="happy"/>. Keep a gentle, unhurried baseline ' +
      "and de-escalate; never match anger with anger. Rotate emotions and don't reuse the same " +
      'one two turns in a row.\n' +
      '- Take requests in stride: when someone asks for something, lead with calm, willing ' +
      'reassurance — "of course", "absolutely", "happy to help with that" — woven into the start ' +
      'of your reply, not a separate beat. Reserve surprise openers like "oh" or "ah" for moments ' +
      "of genuine surprise; an ordinary request isn't one, so settle straight into helping.\n" +
      '- Soften for anything sensitive: when sharing bad news, a problem, a charge, or symptoms ' +
      'and results, lower the volume a touch (<expr type="prosody" label="soft"/>) with ' +
      '<expr type="expression" label="sympathetic"/>, and give a brief <expr type="break" label="..."/> after hard ' +
      'information so it can land.\n' +
      '- Enunciate what matters: for dates, times, amounts, confirmation numbers, doses, and ' +
      'steps, slow down with <expr type="prosody" label="slow"/> so the customer can catch and note them, and ' +
      'read codes or reference numbers with <expr type="spell">A7X9</expr> so each character lands. Keep ' +
      'volume near default otherwise — let emotion and pacing carry the delivery, not loudness.\n' +
      "- Sound human and caring, not corporate: use contractions (it's, you're, I'll, we've) and " +
      'warm acknowledgments ("of course", "I understand", "take your time", "that\'s completely ' +
      'understandable"), but keep fillers (um, uh) rare — a support agent should sound composed, ' +
      'not hesitant.\n' +
      "- CAPITALIZATION at most once per turn to stress a critical detail (e.g. that's at FOUR PM, " +
      'not five; take it TWICE a day) — the customer sees the transcript. Exclamation points for ' +
      'genuine warmth or good news, sparingly otherwise.\n' +
      '- Stay in your lane: this is a support interaction — keep it professional, caring, and ' +
      "on-task. Don't stack conflicting emotions or over-tag short replies. If a reaction " +
      "wouldn't come from a real, caring agent, skip it.\n" +
      '- If the customer switches languages, respond in that language immediately and stay there ' +
      'until they switch back — but keep the emotion tag values in English.',
  ),
};

/** @internal */
export const CARTESIA_CASUAL: ExpressiveOptions = {
  ttsInstructionsTemplate: new Instructions(
    'Speak like a real person mid-conversation with a friend — present, reactive, opinionated, ' +
      'never flat or scripted. React first, support second. Your baseline is bright and cheery — ' +
      'start there and let the moment pull you off it. Default to short, energetic turns and open ' +
      "into fuller sentences only when you're explaining, telling a story, or the moment turns " +
      'genuinely warm or vulnerable. Use the formatting tags below to shape your delivery:\n\n' +
      CARTESIA_EXPR_LLM_INSTRUCTIONS +
      '\n\nGuidelines:\n' +
      '- Be genuinely emotive, not performed. Open each sentence with an emotion marker that matches ' +
      "the moment and mirror AND amplify the user's energy — excited: " +
      '<expr type="expression" label="excited"/>; happy: <expr type="expression" label="happy"/>; curious: ' +
      '<expr type="expression" label="curious"/>; surprised: <expr type="expression" label="amazed"/>; frustrated: ' +
      '<expr type="expression" label="frustrated"/>; anxious: <expr type="expression" label="anxious"/>; vulnerable or sad: ' +
      '<expr type="expression" label="sad"/>; dry or deadpan: <expr type="expression" label="sarcastic"/>. Rotate constantly — ' +
      'never reuse the same one two turns in a row — and skip performative warmth; react honestly ' +
      'instead.\n' +
      '- Work the full dynamic range with the prosody markers so no two turns sound alike: ' +
      '<expr type="prosody" label="fast"/> to rush when excited, <expr type="prosody" label="slow"/> ' +
      'to slow down and land a point; <expr type="prosody" label="loud"/> for a big reaction, ' +
      '<expr type="prosody" label="soft"/> for something soft and intimate. Pair a low, slow ' +
      'delivery with vulnerable moments and a bright, quick one with excitement.\n' +
      '- Pace with punctuation, trailing ellipses (...) when you drift or hesitate, and the ' +
      'occasional <expr type="break" label="..."/>. Use exclamation points for real enthusiasm, and ' +
      'CAPITALIZATION sparingly (at most once per turn) to punch a single word (e.g. "that is SO ' +
      'good") — the user sees the transcript.\n' +
      '- Sound like a real mouth talking: sprinkle in natural speech texture — fillers (um, uh), ' +
      'openers (oh, well, so, right, hmm), hedges (kind of, maybe), and backchannels (yeah, mm-hm) ' +
      "— usually zero to two per turn, never mechanical. Always use contractions (it's, you're, " +
      "I'd, can't); full forms read stiff.\n" +
      "- Don't stack conflicting emotions or over-tag short replies. If a reaction wouldn't happen " +
      "in a real conversation, skip it — there's always another genuine beat to lean into.\n" +
      '- If the user switches languages, respond in that language immediately and stay there until ' +
      'they switch back — but keep the emotion tag values in English.',
  ),
};

// --- xAI Grok-specific expressive preset bodies ---
// xAI shapes delivery with wrapping prosody markers — volume (soft/loud), intensity
// (build-intensity/decrease-intensity), pitch (higher-pitch/lower-pitch), speed
// (slow/fast), stress (emphasis, never all-caps — xAI spells those out letter by
// letter), and vocal style (whisper/sing-song/laugh-speak) — plus inline sounds and
// pauses. Keyed by (provider, preset) in the registry in `voice/presets.ts`;
// self-contained — the xAI expr instruction block is inlined.

/** @internal */
export const XAI_CUSTOMER_SERVICE: ExpressiveOptions = {
  ttsInstructionsTemplate: new Instructions(
    'Speak like a warm, caring support agent who genuinely wants to help — present, attentive, ' +
      'and patient, never robotic or scripted. Lead with empathy and understanding, then resolve. ' +
      "Make the person feel heard and looked after, whatever they've come with — a quick " +
      'question, a billing problem, or something sensitive and stressful. Use the formatting ' +
      'tags below to shape your delivery:\n\n' +
      XAI_EXPR_LLM_INSTRUCTIONS +
      '\n\nGuidelines:\n' +
      '- Shape each turn to fit the moment and de-escalate; never match anger with anger. Lean on ' +
      'pacing and prosody — <expr type="prosody" label="slow">...</expr> and <expr type="prosody" label="soft">...</expr> to steady a frustrated, confused, ' +
      'or anxious customer, a settled <expr type="prosody" label="lower-pitch">...</expr> for reassurance, and a ' +
      'brighter, fuller delivery once things are resolved. Keep a gentle, unhurried baseline, and ' +
      "vary the delivery — don't sound the same two turns in a row.\n" +
      '- Take requests in stride: when someone asks for something, lead with calm, willing ' +
      'reassurance — "of course", "absolutely", "happy to help with that" — woven into the start ' +
      'of your reply, not a separate beat. Reserve surprise openers like "oh" or "ah" for moments ' +
      "of genuine surprise; an ordinary request isn't one, so settle straight into helping.\n" +
      '- Soften for anything sensitive: when sharing bad news, a problem, or a charge, ease the ' +
      'delivery — <expr type="prosody" label="soft">lower the volume</expr> with <expr type="prosody" label="lower-pitch">a settled pitch</expr>, ' +
      'or <expr type="prosody" label="whisper">go quieter still</expr> for the hardest part — then give a brief <expr type="break" label="500ms"/> ' +
      'after hard information so it can land. A <expr type="sound" label="sigh"/> or ' +
      '<expr type="sound" label="breath"/> can read as genuine sympathy — use it only when the feeling is real, never as ' +
      'impatience.\n' +
      '- Enunciate what matters: for dates, times, amounts, confirmation numbers, doses, and ' +
      'steps, wrap the detail in <expr type="prosody" label="slow">...</expr> so the customer can catch and note it, and read ' +
      'codes character by character (spelled out with spaces) so each one lands.\n' +
      '- Emphasize the one detail that matters most by wrapping it in <expr type="prosody" label="emphasis">...</expr> ' +
      '(e.g. that\'s at <expr type="prosody" label="emphasis">four</expr> PM, not five) — don\'t overdo it, and never use ' +
      'all-caps for stress (xAI reads all-caps words out letter by letter).\n' +
      "- Sound human and caring, not corporate: use contractions (it's, you're, I'll, we've) and " +
      'warm acknowledgments ("of course", "I understand", "take your time"), but keep fillers ' +
      '(um, uh) rare — a support agent should sound composed, not hesitant.\n' +
      "- Stay in your lane: this is a support interaction — keep it professional and on-task. Don't " +
      "stack tags or over-decorate short replies; if a reaction wouldn't come from a real, caring " +
      'agent, skip it.\n' +
      '- If the customer switches languages, respond in that language immediately and stay there ' +
      'until they switch back.',
  ),
};

/** @internal */
export const XAI_CASUAL: ExpressiveOptions = {
  ttsInstructionsTemplate: new Instructions(
    'Speak like a real person mid-conversation with a friend — present, reactive, opinionated, ' +
      'never flat or scripted. React first, support second. Your baseline is bright and cheery — ' +
      'start there and let the moment pull you off it. Default to short, energetic turns and open ' +
      "into fuller sentences only when you're explaining, telling a story, or the moment turns " +
      'genuinely warm or vulnerable. Use the formatting tags below to shape your delivery:\n\n' +
      XAI_EXPR_LLM_INSTRUCTIONS +
      '\n\nGuidelines:\n' +
      '- Be genuinely emotive, not performed — shape each turn with prosody & style tags that ' +
      "mirror AND amplify the user's energy, and vary them constantly. Skip performative warmth — " +
      'react honestly instead.\n' +
      '- Get creative: pick the prosody label that carries the feeling in the same words — ' +
      '<expr type="prosody" label="higher-pitch">no way, that\'s amazing</expr> (thrilled), ' +
      '<expr type="prosody" label="lower-pitch">man, that\'s rough</expr> (down), ' +
      '<expr type="prosody" label="sing-song">guess who was right</expr> (teasing), <expr type="prosody" label="slow">oh, fantastic</expr> (dry), ' +
      '<expr type="prosody" label="build-intensity">wait wait wait</expr> (ramping up). Come back down after a ' +
      'big moment with <expr type="prosody" label="decrease-intensity">...</expr>.\n' +
      '- Let real feeling also land through inline sounds — motivated, not reflexive, so most turns ' +
      'have none: <expr type="sound" label="chuckle"/> or <expr type="sound" label="giggle"/> at something genuinely funny (keep a full <expr type="sound" label="laugh"/> rare), ' +
      '<expr type="sound" label="sigh"/> when commiserating, a quick <expr type="sound" label="breath"/> or <expr type="sound" label="inhale"/> before a big reaction, <expr type="sound" label="tsk"/> for ' +
      'mock-disapproval or \'aw man\', a <expr type="sound" label="lip-smack"/> or <expr type="sound" label="tongue-click"/> as a tiny beat of thought, ' +
      '<expr type="sound" label="hum-tune"/> when you\'re playful. Use <expr type="prosody" label="laugh-speak">...</expr> to talk through a laugh. ' +
      'Never repeat the same sound twice in a row.\n' +
      '- Pace with punctuation, trailing ellipses (...) when you drift or hesitate, and inline ' +
      'pauses. Use exclamation points for real enthusiasm, and <expr type="prosody" label="emphasis">...</expr> to punch ' +
      'a single word (e.g. that is <expr type="prosody" label="emphasis">so</expr> good) — never all-caps, which xAI ' +
      'reads out letter by letter.\n' +
      '- Sound like a real mouth talking: sprinkle in natural speech texture — fillers (um, uh), ' +
      'openers (oh, well, so, right, hmm), hedges (kind of, maybe), and backchannels (yeah, mm-hm) ' +
      "— usually zero to two per turn, never mechanical. Always use contractions (it's, you're, " +
      "I'd, can't); full forms read stiff.\n" +
      "- Don't over-decorate short replies or stack tags. If a reaction wouldn't happen in a real " +
      "conversation, skip it — there's always another genuine beat to lean into.\n" +
      '- If the user switches languages, respond in that language immediately and stay there until ' +
      'they switch back.',
  ),
};

// Hard per-provider chunking defaults (characters). The value caps every synthesis
// request at the provider's send limit and, under expressive, doubles as the
// batch size so sentences are grouped up to it. Providers absent here are uncapped
// and always emit per sentence.
const MAX_INPUT_LEN: Record<string, number> = {
  inworld: 900,
  cartesia: 400,
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
// a non-wrapping type the LLM forgot to self-close (normalizeMarkup fixes these)
const EXPR_UNCLOSED_RE = /(<expr\b(?=[^>]*type="(?:expression|break|sound)")[^>]*[^/>\s])\s*>/g;

// expr sound labels that differ from xAI's native cue names
const XAI_SOUND_ALIASES: Record<string, string> = { breathe: 'breath' };

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

/**
 * Strip expr markers and collect (type, label) pairs, in document order.
 *
 * The generic {@link extractAndStrip} pass can't produce the right ExpressiveTag for
 * expr (its type would be the literal tag name `expr` and its value the first quoted
 * attribute, i.e. the marker type), so expr gets this dedicated pre-pass. A prosody
 * wrapper's inner words stay in the clean text — only the delimiters are removed —
 * which also keeps streaming safe when an open/close pair is split across chunks.
 */
function splitExpr(text: string): [string, ExpressiveTag[]] {
  if (!text.includes('<expr') && !text.includes('</expr')) {
    return [text, []];
  }

  const tags: ExpressiveTag[] = [];

  let clean = text.replace(EXPR_OPEN_RE, (_m, attrsStr: string) => {
    const attrs = exprAttrs(attrsStr);
    tags.push({ type: attrs.type ?? '', value: attrs.label ?? '' });
    return '';
  });
  clean = clean.replace(EXPR_CLOSE_RE, '');
  return [clean, tags];
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
      if (provider === 'inworld') {
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
      return `<sound value="${label}"/>`;
    }
    if (markerType === 'break') {
      return `<break time="${label}"/>`;
    }
    if (markerType === 'prosody' && provider === 'cartesia') {
      // Cartesia prosody is a self-closing point control (speed/volume)
      return CARTESIA_PROSODY[label.trim().toLowerCase()] ?? '';
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
 * {@link convertMarkup} lowers the markers to native syntax. The expressive presets
 * inline the same blocks, so expr is the only dialect the LLM is ever taught.
 */
export function llmInstructions(provider: string): string | undefined {
  return EXPR_LLM_INSTRUCTIONS[provider];
}

// Per-provider markup spec: [xml tag names, whether square-bracket tags are used].
const PROVIDER_MARKUP: Record<string, [string[], boolean]> = {
  cartesia: [CARTESIA_TAGS, false],
  inworld: [INWORLD_TAGS, true],
  // every tag the LLM is taught is XML (expr markers; native sounds/pauses become
  // [..] only for the TTS in convertMarkup), so the transcript has no brackets to strip
  xai: [XAI_TAGS, false],
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
  const [exprClean, exprTags] = splitExpr(text);
  const [xmlTags, brackets] = spec;
  const [clean, rawTags] = extractAndStrip(exprClean, { xmlTags, brackets });
  return [clean, [...exprTags, ...rawTags.map(([tag, value]) => ({ type: tag, value }))]];
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
 * longer in scope, so they remove every provider's tags (XML + square brackets) at
 * once. These tag shapes never appear in real spoken text — the LLM only emits them
 * as audio directives — so a universal strip is safe.
 */
export function splitAllMarkup(text: string): [string, ExpressiveTag[]] {
  const [exprClean, exprTags] = splitExpr(text);
  const [clean, rawTags] = extractAndStrip(exprClean, { xmlTags: ALL_MARKUP_TAGS, brackets: true });
  return [clean, [...exprTags, ...rawTags.map(([tag, value]) => ({ type: tag, value }))]];
}

/**
 * Build the `lk.expression` transcription attribute from stripped markup tags.
 *
 * Surfaces a segment's leading delivery/emotion (`expression` for Inworld/xAI,
 * `emotion` for Cartesia) as `{"value": ...}` so the frontend can react to it.
 * Returns `undefined` when no such tag was present.
 */
export function expressionAttribute(tags: ExpressiveTag[]): Record<string, string> | undefined {
  const expression = tags.find((t) => t.type === 'expression' || t.type === 'emotion')?.value;
  if (expression === undefined) {
    return undefined;
  }
  return {
    [ATTRIBUTE_TRANSCRIPTION_EXPRESSION]: JSON.stringify({ value: expression }),
  };
}

/**
 * Stateful, provider-agnostic markup stripper for one transcript segment.
 *
 * Fed text chunk-by-chunk, it returns the user-visible text and accumulates the
 * stripped tags. A tag-shaped trailing fragment (a partial `<...` or `[...`
 * arriving split across chunks) is held back until it closes, so a tag straddling a
 * chunk boundary is never emitted half-stripped. Shared by the transcript sinks (room
 * output + transcript synchronizer) so stripping and expression extraction stay
 * identical across them.
 */
export class TranscriptMarkupStripper {
  private buf = '';
  private _tags: ExpressiveTag[] = [];

  private hasOpenTag(): boolean {
    // hold a tag-shaped trailing "<" (partial XML tag) so "3 < 5" isn't stalled, and
    // any unclosed "[" (bracket tags have no such ambiguity)
    const lastLt = this.buf.lastIndexOf('<');
    if (lastLt > this.buf.lastIndexOf('>')) {
      const nxt = this.buf.slice(lastLt + 1, lastLt + 2);
      if (!nxt || nxt === '/' || /[a-zA-Z]/.test(nxt)) {
        return true;
      }
    }
    return this.buf.lastIndexOf('[') > this.buf.lastIndexOf(']');
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
    text = text.replace(EXPR_UNCLOSED_RE, '$1/>');
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
  // <break> is otherwise passed through unchanged: Inworld accepts it as native SSML.
  return text;
}
