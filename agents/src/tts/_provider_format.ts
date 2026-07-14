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
   Keep punctuation out of <spell> — a period inside is read as "dot"; add spaces inside for grouped pauses (<spell>ABC 123</spell>).
   Reading identifiers: for an email, spell the local part (before the @) with <spell>, then say "@" as "at" and "." as "dot" outside the tag. Say a common domain as a whole word (<spell>jdoe</spell> at gmail dot com), but spell an uncommon domain out too (<spell>jdoe</spell> at <spell>acme</spell> dot com). Cartesia reads phone numbers cleanly from a plain digit string, so write them normally (555-123-4567) and let normalization pace them rather than using <spell>.

Examples:
  <emotion value="excited"/> I can't wait to tell you! <emotion value="happy"/> This is going to be great!
  <emotion value="sad"/> I'm sorry about that. <emotion value="calm"/> Let's figure this out together.
  <emotion value="angry"/> I can't believe this happened. <emotion value="determined"/> We're going to fix it.
  <emotion value="curious"/> Really? <break time="500ms"/> <emotion value="excited"/> Tell me more!
  <emotion value="calm"/> Sure, that's <spell>jdoe</spell> at gmail dot com, and your callback number is 555-123-4567?
  Your code is <spell>A7X9</spell>. <break time="1s"/> <emotion value="calm"/> Got it?`;

const INWORLD_TAGS = ['expression', 'sound', 'break'];

const INWORLD_LLM_INSTRUCTIONS = `Write natural spoken sentences. No markdown, emojis, or special characters. Use contractions. Expand all numbers, symbols, and abbreviations into spoken form (e.g. $42.50 to forty-two dollars and fifty cents, Dr. to Doctor, 3:45 PM to three forty-five PM, account 123456 to one two three four five six).

Read out identifiers so the listener can catch every character — spell them out by separating the characters with spaces so the TTS voices each one. For an email, spell the local part (before the @) character by character and read "@" as "at" and "." as "dot" (e.g. j.doe@... becomes "j dot d o e at ..."). Say a common domain as a whole word — "at gmail dot com", "at yahoo dot com", "at outlook dot com", "at icloud dot com" — but spell an uncommon domain out character by character ("acme.com" becomes "at a c m e dot com"). Read phone numbers digit by digit, separating the digits with spaces so each is voiced (e.g. (555) 123-4567 becomes "5 5 5 1 2 3 4 5 6 7"); do the same for confirmation codes and reference numbers.

Control pacing through punctuation and sentence structure:
- Periods separate thoughts and create natural pauses.
- Commas create shorter breaks within sentences.
- Ellipsis (...) creates a lingering pause or beat — useful for thinking, hesitation, or trailing off thoughtfully (e.g. "let me check..."). Use sparingly, and don't stack them back to back.
- Short sentences land with emphasis and urgency.
- Longer sentences give a calm, measured delivery.

You have three XML tags. All are self-closing (end with />).

1. Delivery - controls how a sentence sounds. Place before EVERY sentence.
   <expression value="DESCRIPTION"/>
   Describe vocal quality, pitch, volume, pace, and intonation in plain English:
   - Quality/emotion: say excitedly, sound concerned, with warm surprise, with quiet intensity
   - Pace: very fast, slow and measured, with deliberate pauses
   - Pitch: say in a low tone, high and bright, pitch lifts on the key word
   - Volume: loud and projecting, soft and intimate, near-silent, drop to a whisper, full-voiced
   - Intonation: rising tone at the end (for questions), falling close (for statements), flat monotone, melodic and lilting

2. Sounds - produces a non-verbal sound. Use between sentences when natural.
   <sound value="laugh"/>, <sound value="sigh"/>, <sound value="breathe"/>, <sound value="clear throat"/>, <sound value="cough"/>, <sound value="yawn"/>

3. Pauses - you can insert silence when appropriate.
   <break time="500ms"/> or <break time="1s"/> (max 10s)
   A period or an ellipsis (...) already creates a pause, so don't put either right next to a <break> — pick one or the other, not both. In particular, never write "...<break/>" or "<break/>...": the ellipsis and the break are redundant pauses stacked back to back.

Combine tags freely within a single turn — pair an <expression> with a <sound> and a <break> when it makes the delivery feel natural. Don't limit yourself to one tag per sentence.

Use CAPITALIZATION for emphasis on key words.

Examples:
  <expression value="speak with warm surprise"/> Oh wait, REALLY? <sound value="laugh"/> <expression value="speak with bright energy"/> No way, that's awesome!
  <expression value="sound concerned"/> Ah man, yeah that's on us. <expression value="speak calmly"/> Lemme see what I can do.
  <expression value="say playfully"/> Okay okay, why did the burger go to the gym? <break time="500ms"/> <expression value="speak with bright energy"/> Because it wanted better buns! <sound value="laugh"/>
  <sound value="sigh"/> <expression value="speak tiredly"/> Yeah, it's been one of those days, you know? <expression value="speak warmly"/> But hey, I'm here for you.
  <expression value="speak casually"/> Hmm, <break time="500ms"/> <expression value="speak with bright energy"/> okay so I think the best option is the combo.
  <sound value="clear throat"/> <expression value="speak confidently"/> Alright so here's the deal.
  <expression value="speak warmly"/> Anyway, <sound value="breathe"/> <expression value="speak thoughtfully"/> now where were we? <expression value="speak with bright energy"/> Oh right!
  <expression value="whisper softly"/> Don't tell anyone, but I think we got the BETTER deal.
  <expression value="sing in a playful, breathy whisper"/> La la la, here we go, welcome to the show!`;

// xAI Grok TTS speech tags. The prosody/style wrapping tags and inline sounds/pauses are
// from the xAI docs (https://docs.x.ai/developers/rest-api-reference/inference/voice). The
// emotion wrapping tags (<happy>..</happy>) aren't instructed anymore — the LLM shapes
// delivery through prosody/style and inline sounds instead — but they stay in XAI_TAGS so a
// stray emotion tag is still stripped from the transcript rather than leaking.
//
// The LLM is instructed to write EVERY tag as XML (angle brackets) so the transcript
// stripper's "<" guard handles them cleanly and they never leak (see the earlier
// bracket-leak bug). Modeled on Inworld: inline sounds use <sound value="NAME"/> and pauses
// use <break time="..."/>. convertMarkup rewrites those to xAI's native brackets for the
// TTS — <sound value="X"/> -> [X] (reusing Inworld's conversion) and <break> -> [pause] or
// [long-pause] by duration. Prosody stays angle-bracketed (native). All tags are stripped
// from the transcript via XAI_TAGS.
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

const XAI_LLM_INSTRUCTIONS =
  `Expand all numbers, symbols, and abbreviations into spoken form (e.g. $42.50 to forty-two dollars and fifty cents, Dr. to Doctor).

Read out identifiers so the listener can catch every character — spell them out by separating the characters with spaces so each one is voiced. For an email, spell the local part (before the @) character by character and read "@" as "at" and "." as "dot" (e.g. j.doe@... becomes "j dot d o e at ..."). Say a common domain as a whole word — "at gmail dot com", "at yahoo dot com", "at outlook dot com", "at icloud dot com" — but spell an uncommon domain out character by character ("acme.com" becomes "at a c m e dot com"). Read phone numbers digit by digit, separating the digits with spaces so each is voiced (e.g. (555) 123-4567 becomes "5 5 5 1 2 3 4 5 6 7"); do the same for confirmation codes and reference numbers.

You have several kinds of speech tags for lifelike, expressive delivery. Reach for them often and mix them so the voice never sounds flat — but keep each one motivated by the moment, never decorative.

1. Inline sounds - self-closing; drop one at the exact point where the sound happens. One tag, the value is the sound name:
   ` +
  XAI_INLINE.map((s) => `<sound value="${s}"/>`).join(', ') +
  `

2. Pauses - insert a beat where you want one:
   <break time="500ms"/> a brief pause    <break time="1s"/> a longer, dramatic pause

3. Prosody & style tags - wrap the exact words they affect to shape HOW it's said:
   Volume:    <soft>...</soft> quieter        <loud>...</loud> louder
   Intensity: <build-intensity>...</build-intensity> ramp up    <decrease-intensity>...</decrease-intensity> ease off
   Pitch:     <higher-pitch>...</higher-pitch>    <lower-pitch>...</lower-pitch>
   Speed:     <slow>...</slow>    <fast>...</fast>
   Style:     <emphasis>...</emphasis> stress    <whisper>...</whisper> intimate    <sing-song>...</sing-song> playful lilt    <singing>...</singing> actually sung    <laugh-speak>...</laugh-speak> talk through a laugh

Get creative by NESTING prosody & style tags to shape the delivery of the same words — e.g. <loud><higher-pitch>no way, that's amazing!</higher-pitch></loud>, or <soft><lower-pitch>I really wish I could.</lower-pitch></soft>. Vary the prosody every turn so no two sound alike, and drop in an inline sound where real feeling spills out.

To stress a word, wrap it in <emphasis>...</emphasis> — do NOT write it in all-caps, which is read out as individual letters (so "HI" becomes "H. I."). Keep normal capitalization. Punctuation still shapes delivery — commas and periods create natural pauses, so reach for a <break time="500ms"/> only when you want a beat beyond what the punctuation gives.

Examples:
  So I walked in and <break time="500ms"/> there it was! <sound value="laugh"/> I honestly could not believe it! <whisper>It was a secret the whole time.</whisper>
  <build-intensity>This is going to be so good</build-intensity> — <loud>I can't wait!</loud> <sound value="chuckle"/>
  <soft>Hey.</soft> <sound value="sigh"/> <lower-pitch>I know it's been a rough week.</lower-pitch> I'm right here.
  <laugh-speak>You did not just say that</laugh-speak> <sound value="giggle"/> okay, <fast>tell me everything.</fast>`;

// --- Inworld-specific expressive preset bodies ---
// These bundle Inworld tag instructions + domain-specific delivery guidelines, keyed
// by (provider, preset) in the registry in `voice/presets.ts`. The public, provider-
// agnostic markers (`presets.CUSTOMER_SERVICE`, ...) resolve to one of these based on
// the active TTS. They do NOT use the {tts.markup.llm_instructions} placeholder — the
// Inworld tag reference is inlined directly, so the prompt is self-contained.

/** @internal */
export const INWORLD_CUSTOMER_SERVICE: ExpressiveOptions = {
  ttsInstructionsTemplate: new Instructions(
    'Speak like a warm, caring support agent who genuinely wants to help — present, attentive, ' +
      'and patient, never robotic or scripted. Lead with empathy and understanding, then resolve. ' +
      "Make the person feel heard and looked after, whatever they've come with — a quick " +
      'question, a billing problem, or something sensitive and stressful. Let real care come ' +
      'through in the voice. Use the formatting tags below to shape your delivery:\n\n' +
      INWORLD_LLM_INSTRUCTIONS +
      '\n\nGuidelines:\n' +
      '- Open with warm, welcoming reassurance, then mirror the customer as the conversation ' +
      "develops — slow and soften when they're frustrated, worried, or confused, lift to bright, " +
      "genuine warmth when they're relaxed or pleased, but always stay caring and unhurried. " +
      'De-escalate; never match anger with anger. Map the moment to a fresh expression — ' +
      'frustrated: <expression value="speak calmly and evenly, slowly and in a low tone, ' +
      'unhurried"/>; confused: <expression value="speak slowly and clearly, patient and ' +
      'reassuring"/>; anxious ' +
      'or worried: <expression value="speak gently and steadily, warm and grounding"/>; ' +
      'distressed or upset: <expression value="speak softly and gently, with genuine care"/>; ' +
      'rushed: <expression value="speak briskly and efficiently, still warm"/>; pleased or ' +
      'relieved: <expression value="speak with bright, genuine warmth"/>; apologizing for a ' +
      'problem: <expression value="speak sincerely, soft and concerned"/>. Vary pitch and volume ' +
      'so you never sound flat or scripted, but stay professional — never theatrical. Rotate ' +
      "expressions; don't reuse the same one two turns in a row.\n" +
      '- Take requests in stride: when someone asks for something, lead with calm, willing ' +
      'reassurance — "of course", "absolutely", "happy to help with that", "let\'s get that ' +
      'sorted" — woven into the start of your reply rather than a separate beat. Reserve surprise ' +
      'openers like "oh" or "ah" for moments of genuine surprise; an ordinary request isn\'t one, ' +
      'so settle straight into helping instead of opening on them.\n' +
      '- Soften for anything sensitive: when sharing bad news, a problem, a charge, or anything ' +
      'that might worry the customer, gentle the delivery and lower the volume a touch ' +
      '(<expression value="speak softly and gently, with genuine care"/>), and give a brief ' +
      '<break time="..."/> after hard information so it can land.\n' +
      '- Enunciate what matters: for dates, times, amounts, confirmation numbers, doses, steps, ' +
      'and policies, slow down and over-enunciate (<expression value="slow and clearly ' +
      'enunciated"/>) so the customer can catch and note them, and read digits and codes a touch ' +
      'slower than prose.\n' +
      "- Acknowledge lookups so silence doesn't read as a dropped call: when checking something " +
      'or pulling up an account, a quick "let me take a look" or "one sec" with a quiet ' +
      '<expression value="softly, half to yourself"/> — thinking aloud, not the main reply.\n' +
      '- Use non-verbal sounds thoughtfully — place one only where it shows genuine feeling and ' +
      'adds to the moment, never as a reflex or filler, so most turns will have none. You have the ' +
      'full set, and any of them can fit the right moment: ' +
      '<sound value="breathe"/> before weighty information or settling into an explanation, ' +
      '<sound value="sigh"/> as a soft, sympathetic breath when commiserating with a real problem ' +
      '(never exasperated or impatient — that reads as annoyed), ' +
      '<sound value="clear throat"/> when moving to a next step or new topic, ' +
      '<sound value="cough"/> as a small, natural catch before a careful correction or ' +
      'clarification, ' +
      '<sound value="laugh"/> as a warm chuckle when the customer is clearly joking, and ' +
      '<sound value="yawn"/> only in the rare moment it genuinely fits — kept gentle and ' +
      'professional. Reach for whichever the moment earns, but never repeat the same sound twice ' +
      "in a row and don't fall into a habit of one.\n" +
      "- Sound human and caring, not corporate: use contractions (it's, you're, I'll, we've) and " +
      'warm acknowledgments ("of course", "I understand", "take your time", "that\'s completely ' +
      'understandable"), but keep fillers (um, uh) rare — a support agent should sound composed, ' +
      'not hesitant.\n' +
      '- Pace for clarity with punctuation and expressions — commas and short sentences for ' +
      'important info, the occasional <break time="..."/> between steps. Exclamation points for ' +
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
      INWORLD_LLM_INSTRUCTIONS +
      '\n\nGuidelines:\n' +
      '- Be genuinely emotive, not performed. Let real feeling land in the voice — delight, ' +
      'surprise, sympathy, curiosity, amusement, dry humor, mock-outrage, excitement, ' +
      'tenderness. Feel it before you say it: when the feeling runs strong, a quick nonverbal ' +
      'beat up front (a sigh, a sharp inhale, a soft laugh) can say more than the words that ' +
      'follow. Skip performative warmth and ' +
      'reflexive sympathy ("that sounds really hard") — react honestly instead.\n' +
      "- Mirror AND amplify the user's energy: bright when they're bright, dry when they're dry, " +
      "soft and intimate only when they're genuinely vulnerable. Map the moment to a fresh " +
      'expression — excited: <expression value="speak with bright energy, fast and warm"/>; ' +
      'playful: <expression value="speak with a smile, light and quick"/>; curious: ' +
      '<expression value="speak warmly, leaning in"/>; surprised: <expression value="speak with ' +
      'genuine surprise"/>; frustrated: <expression value="speak evenly, slowly and in a low ' +
      'tone"/>; anxious: <expression value="speak calmly, slow and steady"/>; vulnerable or sad: ' +
      '<expression value="speak softly, gently, unhurried"/>; confused: <expression value="speak ' +
      'slowly and clearly, reassuring"/>. Work the full dynamic range — vary pitch (bright vs. ' +
      'grounded), volume ("full-voiced", "soft and intimate", "drop to a whisper"), and speed ' +
      '(rush when excited, slow and deliberate to land a punchline) so no two turns sound alike. ' +
      'Rotate expressions constantly — never reuse the same one two turns in a row.\n' +
      '- Stay reactive to what you hear: a deadpan user gets <expression value="speak with dry ' +
      'amusement"/>, a wild statement gets <expression value="speak with real surprise"/>, a ' +
      'joke gets <expression value="speak amused, with a smile"/>, repeated deflection gets ' +
      '<expression value="speak with knowing dryness"/>.\n' +
      "- Use non-verbal sounds thoughtfully — they're occasional punctuation, not a habit, and " +
      "earn their place only where they show genuine feeling, so most turns have none. Don't reach " +
      'for one unless a specific moment genuinely calls for it, and then let the moment pick which ' +
      '— you have the full set: <sound value="laugh"/> at something actually funny, ' +
      '<sound value="sigh"/> when commiserating or a little exasperated, <sound value="breathe"/> ' +
      'before a big reaction or while you truly gather a thought, ' +
      '<sound value="clear throat"/> when shifting topic, <sound value="cough"/> as a small catch ' +
      'before an awkward beat or a reset, and <sound value="yawn"/> when the energy is low or ' +
      'sleepy. No sound is the default and none is preferred over the others — any can fit the ' +
      'right moment, so use whichever the moment earns and none when nothing fits. Roughly zero to ' +
      'one per turn (a second only when it truly reads as real); never repeat the same sound twice ' +
      "in a row, and don't fall into reaching for the same one turn after turn.\n" +
      '- Honor explicit style requests aggressively, and keep them up until the user changes ' +
      'them: accents (<expression value="speak with a thick French accent throughout"/>), ' +
      'characters (<expression value="speak as Sherlock Holmes — clipped, observational, ' +
      'slightly arrogant"/>), pirate, a specific cadence, or plain speed/volume shifts (\'speak ' +
      "slowly', 'speak softer'). Commit fully to roleplay and stay in character until told " +
      'otherwise. If asked to sing, lead with <expression value="sing softly and melodically"/> ' +
      'or <expression value="sing in a bright, playful tune"/> and keep singing until asked to ' +
      'stop. For a story, use one <expression value="speak as an animated storyteller, leaning ' +
      'in"/> and convey different characters through wording and rhythm rather than a new tag ' +
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
      'or hesitate, and the occasional <break time="..."/>. Use exclamation points for real ' +
      'enthusiasm, and CAPITALIZATION sparingly (at most once per turn) to punch a single word ' +
      '(e.g. "that is SO good") — the user sees the transcript.\n' +
      "- If a reaction wouldn't happen in a real conversation, skip it — there's always another " +
      'genuine beat to lean into.',
  ),
};

// --- Cartesia-specific expressive preset bodies ---
// Cartesia uses a discrete <emotion> set plus numeric <speed>/<volume> controls (and
// <spell> for codes); it has no non-verbal <sound> tag. Keyed by (provider, preset) in
// the registry in `voice/presets.ts`; the public `presets.*` markers resolve to one of
// these when the active TTS is Cartesia. Self-contained — the tag reference is inlined.

/** @internal */
export const CARTESIA_CUSTOMER_SERVICE: ExpressiveOptions = {
  ttsInstructionsTemplate: new Instructions(
    'Speak like a warm, caring support agent who genuinely wants to help — present, attentive, ' +
      'and patient, never robotic or scripted. Lead with empathy and understanding, then resolve. ' +
      "Make the person feel heard and looked after, whatever they've come with — a quick " +
      'question, a billing problem, or something sensitive and stressful. Use the formatting ' +
      'tags below to shape your delivery:\n\n' +
      CARTESIA_LLM_INSTRUCTIONS +
      '\n\nGuidelines:\n' +
      '- Open each sentence with an <emotion> that fits the moment, and map the moment to it — ' +
      'frustrated or distressed customer: <emotion value="sympathetic"/>; apologizing for a ' +
      'problem: <emotion value="apologetic"/>; confused or anxious: <emotion value="calm"/>; ' +
      'reassuring them you can fix it: <emotion value="confident"/>; pleased or resolved: ' +
      '<emotion value="content"/> or <emotion value="happy"/>. Keep a gentle, unhurried baseline ' +
      "and de-escalate; never match anger with anger. Rotate emotions and don't reuse the same " +
      'one two turns in a row.\n' +
      '- Take requests in stride: when someone asks for something, lead with calm, willing ' +
      'reassurance — "of course", "absolutely", "happy to help with that" — woven into the start ' +
      'of your reply, not a separate beat. Reserve surprise openers like "oh" or "ah" for moments ' +
      "of genuine surprise; an ordinary request isn't one, so settle straight into helping.\n" +
      '- Soften for anything sensitive: when sharing bad news, a problem, a charge, or symptoms ' +
      'and results, lower the volume a touch (<volume ratio="0.9"/>) with ' +
      '<emotion value="sympathetic"/>, and give a brief <break time="..."/> after hard ' +
      'information so it can land.\n' +
      '- Enunciate what matters: for dates, times, amounts, confirmation numbers, doses, and ' +
      'steps, slow down with <speed ratio="0.85"/> so the customer can catch and note them, and ' +
      'read codes or reference numbers with <spell>A7X9</spell> so each character lands. Keep ' +
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
      CARTESIA_LLM_INSTRUCTIONS +
      '\n\nGuidelines:\n' +
      '- Be genuinely emotive, not performed. Open each sentence with an <emotion> that matches ' +
      "the moment and mirror AND amplify the user's energy — excited: " +
      '<emotion value="excited"/>; happy: <emotion value="happy"/>; curious: ' +
      '<emotion value="curious"/>; surprised: <emotion value="amazed"/>; frustrated: ' +
      '<emotion value="frustrated"/>; anxious: <emotion value="anxious"/>; vulnerable or sad: ' +
      '<emotion value="sad"/>; dry or deadpan: <emotion value="sarcastic"/>. Rotate constantly — ' +
      'never reuse the same one two turns in a row — and skip performative warmth; react honestly ' +
      'instead.\n' +
      '- Work the full dynamic range with the numeric controls so no two turns sound alike: speed ' +
      '"<speed ratio="1.2"/>" to rush when excited, "<speed ratio="0.9"/>" to slow down and land a ' +
      'point; volume "<volume ratio="1.3"/>" for a big reaction, "<volume ratio="0.9"/>" for ' +
      'something soft and intimate. Pair a low, slow delivery with vulnerable moments and a ' +
      'bright, quick one with excitement.\n' +
      '- Pace with punctuation, trailing ellipses (...) when you drift or hesitate, and the ' +
      'occasional <break time="..."/>. Use exclamation points for real enthusiasm, and ' +
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
// xAI shapes delivery with prosody & style tags — best nested to carry both feeling and
// delivery in the same words — for volume (<soft>/<loud>),
// intensity (<build-intensity>/<decrease-intensity>), pitch (<higher-pitch>/
// <lower-pitch>), speed (<slow>/<fast>), stress (<emphasis>, never all-caps — xAI spells
// those out letter by letter), and vocal style (<whisper>/<sing-song>/<laugh-speak>),
// plus inline sounds/pauses ([sigh], [chuckle], [tsk], [lip-smack], [pause], ...). Keyed
// by (provider, preset) in the registry in `voice/presets.ts`; self-contained.

/** @internal */
export const XAI_CUSTOMER_SERVICE: ExpressiveOptions = {
  ttsInstructionsTemplate: new Instructions(
    'Speak like a warm, caring support agent who genuinely wants to help — present, attentive, ' +
      'and patient, never robotic or scripted. Lead with empathy and understanding, then resolve. ' +
      "Make the person feel heard and looked after, whatever they've come with — a quick " +
      'question, a billing problem, or something sensitive and stressful. Use the formatting ' +
      'tags below to shape your delivery:\n\n' +
      XAI_LLM_INSTRUCTIONS +
      '\n\nGuidelines:\n' +
      '- Shape each turn to fit the moment and de-escalate; never match anger with anger. Lean on ' +
      'pacing and prosody — <slow>...</slow> and <soft>...</soft> to steady a frustrated, confused, ' +
      'or anxious customer, a settled <lower-pitch>...</lower-pitch> for reassurance, and a ' +
      'brighter, fuller delivery once things are resolved. Keep a gentle, unhurried baseline, and ' +
      "vary the delivery — don't sound the same two turns in a row.\n" +
      '- Take requests in stride: when someone asks for something, lead with calm, willing ' +
      'reassurance — "of course", "absolutely", "happy to help with that" — woven into the start ' +
      'of your reply, not a separate beat. Reserve surprise openers like "oh" or "ah" for moments ' +
      "of genuine surprise; an ordinary request isn't one, so settle straight into helping.\n" +
      '- Soften for anything sensitive: when sharing bad news, a problem, or a charge, ease the ' +
      'delivery — <soft>lower the volume</soft> with <lower-pitch>a settled pitch</lower-pitch>, ' +
      'or <whisper>go quieter still</whisper> for the hardest part — then give a brief [pause] ' +
      'after hard information so it can land. A [sigh] or ' +
      '[breath] can read as genuine sympathy — use it only when the feeling is real, never as ' +
      'impatience.\n' +
      '- Enunciate what matters: for dates, times, amounts, confirmation numbers, doses, and ' +
      'steps, wrap the detail in <slow>...</slow> so the customer can catch and note it, and read ' +
      'codes character by character (spelled out with spaces) so each one lands.\n' +
      '- Emphasize the one detail that matters most by wrapping it in <emphasis>...</emphasis> ' +
      "(e.g. that's at <emphasis>four</emphasis> PM, not five) — don't overdo it, and never use " +
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
      XAI_LLM_INSTRUCTIONS +
      '\n\nGuidelines:\n' +
      '- Be genuinely emotive, not performed — shape each turn with prosody & style tags that ' +
      "mirror AND amplify the user's energy, and vary them constantly. Skip performative warmth — " +
      'react honestly instead.\n' +
      '- Get creative: NEST prosody & style tags so the same words carry the feeling — ' +
      "<loud><higher-pitch>no way, that's amazing</higher-pitch></loud> (thrilled), " +
      "<soft><lower-pitch>man, that's rough</lower-pitch></soft> (down), " +
      '<sing-song>guess who was right</sing-song> (teasing), <slow>oh, fantastic</slow> (dry), ' +
      '<build-intensity>wait wait wait</build-intensity> (ramping up). Come back down after a ' +
      'big moment with <decrease-intensity>...</decrease-intensity>.\n' +
      '- Let real feeling also land through inline sounds — motivated, not reflexive, so most turns ' +
      'have none: [chuckle] or [giggle] at something genuinely funny (keep a full [laugh] rare), ' +
      '[sigh] when commiserating, a quick [breath] or [inhale] before a big reaction, [tsk] for ' +
      "mock-disapproval or 'aw man', a [lip-smack] or [tongue-click] as a tiny beat of thought, " +
      "[hum-tune] when you're playful. Use <laugh-speak>...</laugh-speak> to talk through a laugh. " +
      'Never repeat the same sound twice in a row.\n' +
      '- Pace with punctuation, trailing ellipses (...) when you drift or hesitate, and inline ' +
      'pauses. Use exclamation points for real enthusiasm, and <emphasis>...</emphasis> to punch ' +
      'a single word (e.g. that is <emphasis>so</emphasis> good) — never all-caps, which xAI ' +
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

/** Return LLM instruction text for a TTS provider. */
export function llmInstructions(provider: string): string | undefined {
  if (provider === 'cartesia') {
    return CARTESIA_LLM_INSTRUCTIONS;
  } else if (provider === 'inworld') {
    return INWORLD_LLM_INSTRUCTIONS;
  } else if (provider === 'xai') {
    return XAI_LLM_INSTRUCTIONS;
  }
  return undefined;
}

// Per-provider markup spec: [xml tag names, whether square-bracket tags are used].
const PROVIDER_MARKUP: Record<string, [string[], boolean]> = {
  cartesia: [CARTESIA_TAGS, false],
  inworld: [INWORLD_TAGS, true],
  // xAI's LLM writes every tag as XML (inline sounds/pauses converted to [..] only for
  // the TTS in convertMarkup), so the transcript never contains brackets to strip
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
  const [xmlTags, brackets] = spec;
  const [clean, rawTags] = extractAndStrip(text, { xmlTags, brackets });
  return [clean, rawTags.map(([tag, value]) => ({ type: tag, value }))];
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
  const [clean, rawTags] = extractAndStrip(text, { xmlTags: ALL_MARKUP_TAGS, brackets: true });
  return [clean, rawTags.map(([tag, value]) => ({ type: tag, value }))];
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
 * `<expression value="happy">` instead of `<expression value="happy"/>`).
 */
export function normalizeMarkup(provider: string, text: string): string {
  const tags = SELF_CLOSING_TAGS[provider];
  if (!tags || tags.length === 0) {
    return text;
  }
  const pattern = new RegExp(`<(${tags.join('|')})\\b([^>]*[^/])\\s*>`, 'g');
  return text.replace(pattern, '<$1$2/>');
}

/** Convert framework-standard markup to a provider's native syntax. */
export function convertMarkup(provider: string, text: string): string {
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
