// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the LiveKit expression marker (expr) dialect.
 *
 * The LLM emits a single marker tag — `<expr type="..." label="..."/>` (self-closing for
 * expression/break/sound, wrapping for prosody/spell) — and the framework lowers it to
 * each provider's native markup before synthesis while stripping it from transcripts. The
 * syntax is shared, but the kinds and label vocabularies are per provider: each provider's
 * instruction block advertises only what that provider supports.
 */
import { describe, expect, it } from 'vitest';
import { ChatContext, ChatMessage } from '../llm/chat_context.js';
import { type TimedString, createTimedString } from '../voice/io.js';
import { matchMood } from './mood.js';
import {
  TranscriptMarkupStripper,
  convertMarkup,
  dropBracketCues,
  expressionAttribute,
  llmInstructions,
  maxInputLen,
  normalizeMarkup,
  sentenceTokenizer,
  splitAllMarkup,
  steeringInstructions,
  stripAllMarkup,
  stripExprMarkup,
  supportedNonverbals,
} from './provider_format.js';

// Inworld-flavored turn: free-form expression + sound + break
const JOKE =
  '<expr type="expression" label="say playfully"/> Why did the burger go to the gym? ' +
  '<expr type="break" label="500ms"/> Because it wanted better buns! ' +
  '<expr type="sound" label="laugh"/>';

describe('convertMarkup: expr -> xAI', () => {
  it('lowers sounds, breaks and wrapping prosody', () => {
    const text =
      'So I walked in and <expr type="break" label="500ms"/> there it was! ' +
      '<expr type="sound" label="laugh"/> ' +
      '<expr type="prosody" label="whisper">It was a secret the whole time.</expr>';
    expect(convertMarkup('xai', text)).toBe(
      'So I walked in and [pause] there it was! [laugh] ' +
        '<whisper>It was a secret the whole time.</whisper>',
    );
  });

  it('maps break durations to the two native pause levels', () => {
    expect(convertMarkup('xai', '<expr type="break" label="50ms"/>')).toBe('[pause]');
    expect(convertMarkup('xai', '<expr type="break" label="2s"/>')).toBe('[long-pause]');
  });

  it('aliases an Inworld-style sound label to the native cue', () => {
    expect(convertMarkup('xai', '<expr type="sound" label="breathe"/>')).toBe('[breath]');
  });

  it('normalizes multi-word prosody labels to hyphenated tag names', () => {
    const text = '<expr type="prosody" label="higher pitch">no way</expr>';
    expect(convertMarkup('xai', text)).toBe('<higher-pitch>no way</higher-pitch>');
  });

  it('unwraps an unknown prosody label', () => {
    const text = '<expr type="prosody" label="like a pirate">ahoy there</expr>';
    expect(convertMarkup('xai', text)).toBe('ahoy there');
  });

  it('drops a hallucinated expression marker from the audio path', () => {
    // xAI has no free-form delivery descriptions; the marker still surfaces in
    // transcript tags
    const text = '<expr type="expression" label="say playfully"/> Hello!';
    expect(convertMarkup('xai', text)).toBe(' Hello!');
  });
});

describe('convertMarkup: expr -> Inworld', () => {
  it('lowers expression/sound to brackets and keeps break as native SSML', () => {
    expect(convertMarkup('inworld', JOKE)).toBe(
      '[say playfully] Why did the burger go to the gym? ' +
        '<break time="500ms"/> Because it wanted better buns! [laugh]',
    );
  });

  it('salvages a stray prosody marker as a delivery hint', () => {
    const text = '<expr type="prosody" label="whisper">keep it secret</expr>';
    expect(convertMarkup('inworld', text)).toBe('[whisper]keep it secret');
  });
});

describe('convertMarkup: expr -> Cartesia', () => {
  it('lowers expression to <emotion>, keeps break, drops sound', () => {
    const text =
      '<expr type="expression" label="excited"/> We won! ' +
      '<expr type="break" label="1s"/> <expr type="sound" label="laugh"/> Unbelievable.';
    // without leaving the space the dropped marker sat between behind as a doubled
    // separator
    expect(convertMarkup('cartesia', text)).toBe(
      '<emotion value="excited"/> We won! <break time="1s"/> Unbelievable.',
    );
  });

  it('lowers spell to the native tag', () => {
    const text = 'Your code is <expr type="spell">A7X9</expr>.';
    expect(convertMarkup('cartesia', text)).toBe('Your code is <spell>A7X9</spell>.');
  });

  it('unwraps spell for providers that lack it', () => {
    const text = 'Your code is <expr type="spell">A7X9</expr>.';
    expect(convertMarkup('xai', text)).toBe('Your code is A7X9.');
    expect(convertMarkup('inworld', text)).toBe('Your code is A7X9.');
  });

  it('lowers prosody labels to native speed/volume point controls', () => {
    expect(convertMarkup('cartesia', '<expr type="prosody" label="slow"/> One moment.')).toBe(
      '<speed ratio="0.85"/> One moment.',
    );
    expect(convertMarkup('cartesia', '<expr type="prosody" label="loud"/> We won!')).toBe(
      '<volume ratio="1.3"/> We won!',
    );
    // wrapping form applies the control before the span
    expect(convertMarkup('cartesia', '<expr type="prosody" label="soft">bad news</expr>')).toBe(
      '<volume ratio="0.9"/>bad news',
    );
  });

  it('unwraps an unknown prosody label', () => {
    const text = '<expr type="prosody" label="whisper">keep it secret</expr>';
    expect(convertMarkup('cartesia', text)).toBe('keep it secret');
  });

  it('does not let a self-closing prosody marker swallow a later span', () => {
    // Cartesia's prosody markers are self-closing point controls. Read as an opening tag,
    // one would run to the next </expr> and eat the spell marker with it — the code would
    // reach the TTS as a bare word and be pronounced instead of spelled out.
    const text =
      '<expr type="prosody" label="slow"/> One moment. ' +
      'Your code is <expr type="spell">A7X9</expr>.';
    expect(convertMarkup('cartesia', text)).toBe(
      '<speed ratio="0.85"/> One moment. Your code is <spell>A7X9</spell>.',
    );
  });

  it('keeps each self-closing marker distinct across a sentence', () => {
    const text =
      '<expr type="prosody" label="loud"/> Big news! <expr type="prosody" label="soft"/> Or not.';
    expect(convertMarkup('cartesia', text)).toBe(
      '<volume ratio="1.3"/> Big news! <volume ratio="0.9"/> Or not.',
    );
  });
});

describe('convertMarkup: expr -> Fish Audio', () => {
  it('lowers expression to an intensified bracket cue and sounds to their aliases', () => {
    const text =
      '<expr type="expression" label="regretful"/> That\'s on us. ' +
      '<expr type="sound" label="sigh"/>';
    expect(convertMarkup('fishaudio', text)).toBe("[very regretful] That's on us. [sighing]");
  });

  it('lowers a tone wrapper to Fish’s prefix marker form', () => {
    const text = '<expr type="prosody" label="whispering">don\'t tell anyone</expr>';
    expect(convertMarkup('fishaudio', text)).toBe("[whispering] don't tell anyone");
  });

  it('lowers emphasis to the per-word stress marker', () => {
    const text = 'Are you <expr type="prosody" label="emphasis">sure</expr>?';
    expect(convertMarkup('fishaudio', text)).toBe('Are you [emphasis] sure?');
  });

  it('maps break durations to the two native pause levels', () => {
    expect(convertMarkup('fishaudio', '<expr type="break" label="500ms"/>')).toBe('[break]');
    expect(convertMarkup('fishaudio', '<expr type="break" label="2s"/>')).toBe('[long-break]');
  });
});

it('drops a stray expr tag rather than letting it reach the TTS', () => {
  // an unpaired prosody open/close (e.g. split across stream chunks) is dropped, keeping
  // the words
  expect(convertMarkup('xai', '<expr type="prosody" label="loud">hello there')).toBe('hello there');
  expect(convertMarkup('xai', 'hello there</expr>')).toBe('hello there');
});

describe('transcript stripping (provider-agnostic)', () => {
  it('strips expr and reports its tags', () => {
    const [clean, tags] = splitAllMarkup(JOKE);
    expect(clean.trim()).toBe('Why did the burger go to the gym? Because it wanted better buns!');
    expect(tags).toEqual([
      { type: 'expression', value: 'say playfully' },
      { type: 'break', value: '500ms' },
      { type: 'sound', value: 'laugh' },
    ]);
  });

  it('keeps the inner text of a wrapping marker', () => {
    const text =
      'She said <expr type="prosody" label="whisper">keep it secret</expr> — ' +
      'code <expr type="spell">A7X9</expr>.';
    const [clean, tags] = splitAllMarkup(text);
    expect(clean).toBe('She said keep it secret — code A7X9.');
    expect(tags).toEqual([
      { type: 'prosody', value: 'whisper' },
      { type: 'spell', value: '' },
    ]);
  });

  it('strips mixed expr and provider-native tags', () => {
    const text = '<expr type="expression" label="say playfully"/> Hello! <sound value="laugh"/>';
    const [clean, tags] = splitAllMarkup(text);
    expect(clean.trim()).toBe('Hello!');
    expect(tags).toContainEqual({ type: 'expression', value: 'say playfully' });
    expect(tags).toContainEqual({ type: 'sound', value: 'laugh' });
  });

  it('keeps square-bracket spans', () => {
    // bracket spans are a TTS-only native form (convertMarkup emits them on the audio
    // path), so the transcript strip must leave markdown links and prose brackets intact
    const text =
      'Press [Enter], then read [the docs](https://docs.livekit.io). <sound value="sigh"/>';
    const [clean, tags] = splitAllMarkup(text);
    expect(clean).toBe('Press [Enter], then read [the docs](https://docs.livekit.io). ');
    expect(tags).toEqual([{ type: 'sound', value: 'sigh' }]);
  });

  it('does not match the native <expression> tag with the expr regexes', () => {
    // "<expr" is a prefix of "<expression" — the word boundary in the expr regexes must
    // keep the native Inworld tag on the generic strip path with its own type
    const text = '<expression value="speak calmly"/> Hi <expr type="break" label="1s"/> there.';
    const [clean, tags] = splitAllMarkup(text);
    expect(clean).toBe(' Hi there.');
    expect(tags).toContainEqual({ type: 'expression', value: 'speak calmly' });
    expect(tags).toContainEqual({ type: 'break', value: '1s' });
    // conversion must also leave the native tag for the provider pipeline, not eat it
    expect(convertMarkup('inworld', text)).toBe('[speak calmly] Hi <break time="1s"/> there.');
  });

  it('holds a tag split across streamed chunks', () => {
    const stripper = new TranscriptMarkupStripper();
    let out = '';
    // split mid-tag so the partial "<expr ..." must be held back, never half-emitted
    for (const chunk of [
      '<expr type="expr',
      'ession" label="say playfully"/> Hello',
      ' <expr type="prosody" label="whisper">wor',
      'ld</expr>!',
    ]) {
      out += stripper.push(chunk);
    }
    out += stripper.flush();
    // no leading space: the marker opened the segment, so the space it left behind is
    // trimmed (Python leaves it, and its own tests .strip() around it)
    expect(out).toBe('Hello world!');
    expect(stripper.tags[0]).toEqual({ type: 'expression', value: 'say playfully' });
    expect(stripper.tags).toContainEqual({ type: 'prosody', value: 'whisper' });
  });

  it('leaves a single space where a removed tag sat between two', () => {
    // a marker between two spaces must not leave both behind, or punctuation ends up
    // followed by a double space in the transcript
    expect(stripAllMarkup('Right. <expr type="sound" label="laugh"/> Anyway.')).toBe(
      'Right. Anyway.',
    );
    expect(stripAllMarkup('Right. <sound value="laugh"/> Anyway.')).toBe('Right. Anyway.');
    // a wrapping marker keeps its inner text, so its spacing is untouched
    expect(stripAllMarkup('a <expr type="prosody" label="loud">b</expr> c')).toBe('a b c');
    // only the doubled separator goes: a marker with text on one side keeps the space
    expect(stripAllMarkup('Right.<expr type="sound" label="laugh"/> Anyway.')).toBe(
      'Right. Anyway.',
    );
    expect(stripAllMarkup('Right. <expr type="sound" label="laugh"/>Anyway.')).toBe(
      'Right. Anyway.',
    );
    // newlines are structure, not a separator a strip may collapse
    expect(stripAllMarkup('a\n<expr type="sound" label="laugh"/>\nb')).toBe('a\n\nb');
  });

  it('keeps the trailing space before a marker at the end of a chunk', () => {
    // the space before a trailing marker is the separator for words still streaming in,
    // so it survives the strip (the seam is deduped by TranscriptMarkupStripper)
    expect(stripAllMarkup('Right. <expr type="sound" label="laugh"/>')).toBe('Right. ');
  });

  it('dedups the space across chunk seams', () => {
    // the space before the marker goes out with the previous chunk, so the in-text dedup
    // can't see it — the stripper has to close that seam itself
    for (const chunks of [
      ['Right. ', '<expr type="sound" label="laugh"/>', ' Anyway.'],
      ['Right. ', '<expr type="sound" label="laugh"/> Anyway.'],
      ['Right. ', '<sound value="laugh"/>', ' Anyway.'],
    ]) {
      const stripper = new TranscriptMarkupStripper();
      const out = chunks.map((c) => stripper.push(c)).join('') + stripper.flush();
      expect(out, chunks.join('|')).toBe('Right. Anyway.');
    }
  });

  it('leaves untagged whitespace alone', () => {
    // without a stripped tag at the seam there is nothing to dedup: whitespace the LLM
    // itself emitted is passed through untouched
    let stripper = new TranscriptMarkupStripper();
    let out = ['Right. ', ' Anyway.'].map((c) => stripper.push(c)).join('') + stripper.flush();
    expect(out).toBe('Right.  Anyway.');

    // a tag stripped earlier in the chunk doesn't license collapsing the seam either:
    // the whitespace here trails "hello", not the removed tag
    stripper = new TranscriptMarkupStripper();
    out =
      ['<sound value="x"/>hello  ', '   world'].map((c) => stripper.push(c)).join('') +
      stripper.flush();
    expect(out).toBe('hello     world');
  });

  it('builds the lk.expression attribute from the leading expression', () => {
    const [, tags] = splitAllMarkup(JOKE);
    const attr = expressionAttribute(tags);
    expect(attr).toBeDefined();
    expect(Object.values(attr!)[0]).toContain('"say playfully"');
  });

  it('has no lk.expression attribute without an expression tag', () => {
    const [, tags] = splitAllMarkup('Hi <expr type="break" label="1s"/> there.');
    expect(expressionAttribute(tags)).toBeUndefined();
  });
});

describe('normalizeMarkup', () => {
  it.each(['xai', 'inworld', 'cartesia', 'fishaudio'])(
    'closes an unclosed self-closing expr marker for %s',
    (provider) => {
      const text = '<expr type="sound" label="laugh"> Hello';
      expect(normalizeMarkup(provider, text)).toBe('<expr type="sound" label="laugh"/> Hello');
    },
  );

  it('leaves wrapping and already-closed tags alone', () => {
    const text =
      '<expr type="prosody" label="whisper">hi</expr> <expr type="break" label="1s"/> ' +
      '<expr type="spell">A7X9</expr>';
    expect(normalizeMarkup('xai', text)).toBe(text);
  });
});

describe('llmInstructions', () => {
  it.each(['xai', 'inworld', 'cartesia', 'fishaudio'])('uses expr syntax for %s', (provider) => {
    const instructions = llmInstructions(provider);
    expect(instructions).toBeDefined();
    expect(instructions).toContain('<expr');
    expect(instructions).toContain('<expr type="break" label="');
  });

  it('advertises Cartesia’s kinds only', () => {
    const instructions = llmInstructions('cartesia')!;
    // discrete emotion vocabulary, not free-form descriptions
    expect(instructions).toContain('<expr type="expression" label="EMOTION"/>');
    expect(instructions).toContain('NOT free-form');
    expect(instructions).toContain('<expr type="spell">');
    // coarse self-closing prosody point controls
    expect(instructions).toContain('<expr type="prosody" label="slow"/>');
    // no non-verbal sounds
    expect(instructions).not.toContain('type="sound"');
  });

  it('advertises Inworld’s kinds only', () => {
    const instructions = llmInstructions('inworld')!;
    // free-form delivery descriptions + Inworld's own sound list
    expect(instructions).toContain('<expr type="expression" label="DESCRIPTION"/>');
    expect(instructions).toContain('free-form');
    expect(instructions).toContain('clear throat');
    // no wrapping prosody, no spell
    expect(instructions).not.toContain('type="prosody"');
    expect(instructions).not.toContain('type="spell"');
  });

  it('advertises xAI’s kinds only', () => {
    const instructions = llmInstructions('xai')!;
    // xAI's own sound cues + wrapping prosody vocabulary
    expect(instructions).toContain('tongue-click');
    expect(instructions).toContain('<expr type="prosody" label="STYLE">');
    expect(instructions).toContain('sing-song');
    // no free-form delivery descriptions, no spell
    expect(instructions).not.toContain('type="expression"');
    expect(instructions).not.toContain('type="spell"');
  });

  it('is undefined for a provider with no markup dialect', () => {
    expect(llmInstructions('')).toBeUndefined();
    expect(llmInstructions('openai')).toBeUndefined();
    expect(llmInstructions('rime')).toBeUndefined();
  });

  it('omits a sound category that steering disables, and its examples', () => {
    const instructions = llmInstructions('inworld', { nonverbalSounds: { laughing: false } })!;
    expect(instructions).not.toContain('label="laugh"');
    expect(instructions).toContain('clear throat');
  });

  it('omits the whole sounds section when every sound is disabled', () => {
    const instructions = llmInstructions('inworld', { nonverbalSounds: false })!;
    expect(instructions).not.toContain('type="sound"');
  });

  it('renders identically when steering explicitly enables everything', () => {
    expect(llmInstructions('xai', { nonverbalSounds: true })).toBe(llmInstructions('xai'));
    expect(llmInstructions('xai', {})).toBe(llmInstructions('xai'));
  });
});

// assistant text mixing expr markers with content that must survive an expr-only strip:
// provider-native tags, bracket spans, markdown links, and stray angle brackets
const MIXED =
  '<expr type="expression" label="happy"/> Press [Enter] to see <b>bold</b>, ' +
  'read [the docs](https://docs.livekit.io), then 1 < 2. <break time="1s"/> ' +
  '<expr type="prosody" label="whisper">keep it secret</expr>';
const MIXED_CLEAN =
  ' Press [Enter] to see <b>bold</b>, ' +
  'read [the docs](https://docs.livekit.io), then 1 < 2. <break time="1s"/> ' +
  'keep it secret';

describe('stripExprMarkup', () => {
  it('only touches expr', () => {
    expect(stripExprMarkup(MIXED)).toBe(MIXED_CLEAN);
  });

  it('is a no-op without expr', () => {
    const text = 'plain text with [brackets] and <sound value="laugh"/>';
    expect(stripExprMarkup(text)).toBe(text);
  });

  it('strips expr only from assistant textContent', () => {
    const msg = ChatMessage.create({ role: 'assistant', content: [MIXED] });
    expect(msg.textContent).toBe(MIXED_CLEAN);
    expect(msg.rawTextContent).toBe(MIXED);
  });

  it.each(['user', 'system', 'developer'] as const)('leaves %s messages raw', (role) => {
    // only assistant messages carry expressive markup; other roles are never stripped
    const msg = ChatMessage.create({ role, content: [JOKE] });
    expect(msg.textContent).toBe(JOKE);
    expect(msg.rawTextContent).toBe(JOKE);
  });

  it('returns undefined without text content', () => {
    const msg = ChatMessage.create({ role: 'assistant', content: [] });
    expect(msg.textContent).toBeUndefined();
    expect(msg.rawTextContent).toBeUndefined();
  });

  it('toJSON stripMarkup is expr-only and assistant-only', () => {
    const chatCtx = ChatContext.empty();
    chatCtx.addMessage({ role: 'user', content: [MIXED] });
    chatCtx.addMessage({ role: 'assistant', content: [MIXED] });

    let items = chatCtx.toJSON({ stripMarkup: true }).items as Array<{ content: string[] }>;
    expect(items[0]!.content).toEqual([MIXED]); // user content untouched
    expect(items[1]!.content).toEqual([MIXED_CLEAN]); // assistant loses only expr tags

    // default keeps the raw content for persistence
    items = chatCtx.toJSON().items as Array<{ content: string[] }>;
    expect(items[1]!.content).toEqual([MIXED]);
  });
});

describe('universal transcript stripping', () => {
  // The transcript sinks strip downstream without knowing the provider, so they remove
  // the union of every provider's XML tags — but never square brackets, which reach the
  // transcript as markdown/prose.

  it('strips every provider’s tags at once and leaves brackets', () => {
    const [clean, tags] = splitAllMarkup(
      '<emotion value="happy"/>Hi <expression value="warm"/>there ' +
        '<sound value="giggle"/>[pause] friend',
    );
    expect(clean).toBe('Hi there [pause] friend');
    expect(tags).toContainEqual({ type: 'emotion', value: 'happy' });
    expect(tags).toContainEqual({ type: 'expression', value: 'warm' });
    expect(tags).toContainEqual({ type: 'sound', value: 'giggle' });
  });

  it('takes the attribute, not the wrapped words, as a delivery label', () => {
    // the model writes `<expression value="warm">…</expression>` often enough that
    // normalizeMarkup repairs it — but that runs on the audio path only, so the sinks see
    // the raw shape. Recording the inner text here published the agent's own sentence as
    // lk.expression, and matchMood then fell back to `calm`.
    const [clean, tags] = splitAllMarkup('<expression value="warm">Hello there</expression>');
    expect(clean).toBe('Hello there');
    expect(tags).toEqual([{ type: 'expression', value: 'warm' }]);
    expect(expressionAttribute(tags)).toEqual({
      'lk.expression': '{"expression":"warm","mood":"happy"}',
    });
  });

  it('still reads a content tag from its inner text', () => {
    // the inverse must keep working: spell/emphasis and xAI's wrapping emotion tags carry
    // no attribute, so their content is the value
    expect(splitAllMarkup('<spell>A7X9</spell>')[1]).toEqual([{ type: 'spell', value: 'A7X9' }]);
    expect(splitAllMarkup('<emphasis>wow</emphasis>')[1]).toEqual([
      { type: 'emphasis', value: 'wow' },
    ]);
    expect(splitAllMarkup('<happy>Great to hear!</happy>')[1]).toEqual([
      { type: 'happy', value: 'Great to hear!' },
    ]);
  });

  it('produces the documented lk.expression payload shape', () => {
    let [, tags] = splitAllMarkup('<emotion value="sad"/>oh no');
    expect(expressionAttribute(tags)).toEqual({
      'lk.expression': '{"expression":"sad","mood":"sad"}',
    });

    // no expression/emotion tag -> no attribute
    [, tags] = splitAllMarkup('<break time="1s"/>hi');
    expect(expressionAttribute(tags)).toBeUndefined();
  });

  it('holds partial tags while streaming', () => {
    const s = new TranscriptMarkupStripper();
    let out = s.push('Hi <emo');
    out += s.push('tion value="happy"/> the');
    out += s.push('re');
    out += s.flush();
    expect(out).not.toContain('<emotion');
    expect(out.replace(/ /g, '')).toBe('Hithere');
    expect(s.expressionAttribute()).toEqual({
      'lk.expression': '{"expression":"happy","mood":"happy"}',
    });
  });

  it('does not stall on an unclosed markdown link', () => {
    const s = new TranscriptMarkupStripper();
    // an unclosed "[" must not stall the chunk (brackets aren't markup), and the link must
    // arrive intact rather than collapsed to its (url) tail
    const first = s.push('Read [the docs](https:');
    expect(first).toBe('Read [the docs](https:');
    const rest = s.push('//docs.livekit.io) now.') + s.flush();
    expect(first + rest).toBe('Read [the docs](https://docs.livekit.io) now.');
  });

  it('does not stall on a bare "<"', () => {
    const s = new TranscriptMarkupStripper();
    const first = s.push('The value 3 < 5 ');
    expect(first).toContain('3 < 5');
    const rest = s.push('is true.') + s.flush();
    expect((first + rest).replace(/ /g, '')).toBe('Thevalue3<5istrue.');
  });

  it('strips nested emotion + prosody cleanly', () => {
    // combining emotion + prosody means nesting; the transcript must come out clean (no
    // leaked inner markup) — this is what the fixed-point strip guarantees
    const raw =
      '<excited><loud><higher-pitch>no way</higher-pitch></loud></excited> ' +
      '<sound value="laugh"/> okay';
    const [clean] = splitAllMarkup(raw);
    expect(clean).not.toContain('<');
    expect(clean).not.toContain('>');
    expect(clean).toContain('no way');
    expect(clean).toContain('okay');
  });
});

describe('speech steering', () => {
  it('renders nothing for the explicit all-on forms', () => {
    // equivalent configurations must produce identical instructions: the explicit all-on
    // forms add no sound guidance the default doesn't have
    for (const provider of ['fishaudio', 'inworld', 'xai']) {
      for (const steering of [{ nonverbalSounds: true } as const, { nonverbalSounds: {} }]) {
        expect(steeringInstructions(provider, steering), provider).toBe('');
        expect(llmInstructions(provider, steering), provider).toBe(llmInstructions(provider));
      }
    }
    // all-off leaves nothing to guide; the vocabulary removal happens in llmInstructions
    expect(steeringInstructions('fishaudio', { nonverbalSounds: false })).toBe('');
  });

  it('guides only about the sounds that survive an opt-out', () => {
    const partial = steeringInstructions('fishaudio', { nonverbalSounds: { laughing: false } });
    expect(partial).toContain('clear-throat');
    expect(partial.toLowerCase()).not.toContain('laugh');
  });

  it('renders pace and disfluency guidelines', () => {
    expect(steeringInstructions('inworld', { disfluencies: false })).toContain('No fillers');
    expect(steeringInstructions('inworld', { pace: 'slow' })).toContain('slow overall speaking');
    // "normal" is the default, so it adds nothing
    expect(steeringInstructions('inworld', { pace: 'normal' })).toBe('');
  });

  it('never mentions an opted-out concept, not even prohibitively', () => {
    const composed = llmInstructions('fishaudio', {
      nonverbalSounds: false,
      disfluencies: false,
    })!;
    expect(composed.toLowerCase()).not.toContain('laugh');
    expect(composed.toLowerCase()).not.toContain('filler');
    expect(composed).not.toContain('Um, uh');
  });

  it('few-shots fillers only while disfluencies are enabled', () => {
    expect(llmInstructions('fishaudio', { disfluencies: true })).toContain('Um, uh');
    expect(llmInstructions('fishaudio')).toContain('Um, uh'); // default is on
    const off = llmInstructions('fishaudio', { disfluencies: false })!;
    expect(off).not.toContain('Um, uh');
    expect(off).not.toContain(', um,');
  });

  it('exposes the queryable non-verbal capability matrix', () => {
    expect(supportedNonverbals('fishaudio')).toEqual({
      laughing: ['laughing', 'chuckling'],
      breathing: ['gasping'],
      sighing: ['sighing'],
      crying: ['sobbing'],
      vocalizing: ['groaning'],
      reflexSounds: ['clear throat', 'yawning'],
    });
    expect(supportedNonverbals('cartesia')).toEqual({});
  });

  it('treats a category object as a sparse opt-out', () => {
    // omitted categories stay enabled, so { laughing: false } removes laughter and
    // nothing else
    const steering = { nonverbalSounds: { laughing: false } };
    const inworld = llmInstructions('inworld', steering)!;
    expect(inworld).not.toContain('label="laugh"');
    for (const kept of ['sigh', 'breathe', 'clear throat', 'cough', 'yawn']) {
      expect(inworld, kept).toContain(kept);
    }
    // xai's laugh-family prosody is governed by the same field
    const xai = llmInstructions('xai', steering)!;
    expect(xai).not.toContain('laugh-speak');
    expect(xai).toContain('whisper');
  });

  it('carries the register rule in every provider’s block', () => {
    // register inference is provider-neutral: every markup-capable provider's block
    // carries the rule via the shared preamble
    for (const provider of ['fishaudio', 'inworld', 'xai', 'cartesia']) {
      expect(llmInstructions(provider), provider).toContain('REGISTER of the moment');
    }
  });
});

describe('expressive chunking', () => {
  // a typical expressive reply: three short sentences with markers, ~270 chars — well
  // under every provider's request cap
  const REPLY =
    '<expr type="expression" label="really amiable and welcoming"/> Hey, good to hear from you! ' +
    '<expr type="expression" label="gently inquisitive"/> How did the interview go? ' +
    '<expr type="expression" label="really bright, upbeat energy"/> I have been thinking about it all week.';

  /** Feed the reply in LLM-sized chunks; report what the TTS would have received and when. */
  async function synthesisRequests(provider: string, expressive: boolean) {
    const stream = sentenceTokenizer(provider, { expressive }).stream();
    const tokens: string[] = [];
    const reader = (async () => {
      for await (const ev of stream) tokens.push(ev.token);
    })();

    for (const chunk of REPLY.match(/.{1,12}/gs) ?? []) stream.pushText(chunk);
    await new Promise((r) => setImmediate(r));
    // everything emitted at this point went out while the LLM was still generating
    const duringStream = [...tokens];

    stream.endInput();
    await reader;
    return { duringStream, total: tokens.length, first: tokens[0] ?? '' };
  }

  it.each(['inworld', 'xai', 'cartesia'])(
    'leaves time-to-first-audio unchanged for %s',
    async (provider) => {
      const plain = await synthesisRequests(provider, false);
      const expressive = await synthesisRequests(provider, true);

      // regression: the batch target used to be the provider's request cap (400–1000
      // chars). A typical reply never reaches it, so nothing was sent until generation
      // finished and the whole turn was synthesized in one request — first audio waited
      // for the full completion.
      expect(expressive.duringStream.length).toBeGreaterThan(0);
      expect(expressive.first).toBe(plain.first);

      // ...while still batching the body of the turn into fewer requests than per-sentence
      expect(expressive.total).toBeLessThan(plain.total);
    },
  );

  it('keeps fishaudio per-sentence', async () => {
    // its markers are sentence-scoped, so batching would cost first-audio and buy no
    // steering — it is deliberately absent from the chunk-limit table
    const plain = await synthesisRequests('fishaudio', false);
    const expressive = await synthesisRequests('fishaudio', true);
    expect(expressive.total).toBe(plain.total);
  });

  it('never exceeds the provider request cap', async () => {
    const long = Array.from({ length: 40 }, (_, i) => `This is sentence number ${i}.`).join(' ');
    const stream = sentenceTokenizer('cartesia', { expressive: true }).stream();
    const tokens: string[] = [];
    const reader = (async () => {
      for await (const ev of stream) tokens.push(ev.token);
    })();
    stream.pushText(long);
    stream.endInput();
    await reader;

    expect(tokens.length).toBeGreaterThan(1);
    for (const t of tokens) expect(t.length).toBeLessThanOrEqual(maxInputLen('cartesia')!);
  });
});

describe('mood matching', () => {
  it('normalizes free-form delivery labels', () => {
    expect(matchMood('soft, with genuine care')).toBe('empathetic');
    expect(matchMood('gently curious, welcoming')).toBe('curious');
    // word starts only: "like a pirate" must not match `angry` via the "irate" stem
    expect(matchMood('like a pirate')).toBe('calm');
    expect(matchMood('like a pirate', null)).toBeNull();
  });

  it('resolves every advertised Fish emotion to a real mood', () => {
    // lk.expression consumers get a meaningful enum for the whole vocabulary
    const instructions = llmInstructions('fishaudio')!;
    for (const emotion of ['regretful', 'hopeful', 'delighted', 'determined', 'frustrated']) {
      expect(instructions).toContain(emotion);
      expect(matchMood(emotion, null), emotion).not.toBeNull();
    }
  });
});

describe('dropBracketCues', () => {
  const timed = (text: string) => createTimedString({ text, startTime: 0, endTime: 1 });

  it('drops a native cue and one of the spaces it sat between', () => {
    const held: TimedString[] = [];
    const out = dropBracketCues(['Right.', ' ', '[laughing]', ' ', 'Anyway.'].map(timed), held, {
      final: true,
    });
    expect(out.map((t) => t.text).join('')).toBe('Right. Anyway.');
  });

  it('holds an unclosed span across messages until it closes', () => {
    const held: TimedString[] = [];
    let out = dropBracketCues(['Hello ', '[lau'].map(timed), held);
    expect(out.map((t) => t.text).join('')).toBe('Hello ');
    expect(held.length).toBeGreaterThan(0);

    // the cue and the space after it are gone; "Hello " already went out above, so the
    // seam still reads as a single separator
    out = dropBracketCues(['ghing] there'].map(timed), held);
    expect(out.map((t) => t.text).join('')).toBe('there');
  });

  it('releases an unresolved span at end of stream', () => {
    const held: TimedString[] = [];
    dropBracketCues([timed('Hello [lau')], held);
    const out = dropBracketCues([], held, { final: true });
    expect(out.map((t) => t.text).join('')).toBe('[lau');
  });
});
