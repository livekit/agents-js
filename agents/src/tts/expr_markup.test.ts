// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the LiveKit expression marker (expr) dialect.
 *
 * The LLM emits a single marker tag — `<expr type="..." label="..."/>` (self-closing
 * for expression/break/sound, wrapping for prosody/spell) — and the framework lowers it
 * to each provider's native markup before synthesis while stripping it from transcripts.
 * The syntax is shared, but the kinds and label vocabularies are per provider: each
 * provider's instruction block advertises only what that provider supports.
 */
import { describe, expect, it } from 'vitest';
import {
  TranscriptMarkupStripper,
  convertMarkup,
  expressionAttribute,
  llmInstructions,
  normalizeMarkup,
  splitAllMarkup,
  splitMarkup,
} from './_provider_format.js';

// Inworld-flavored turn: free-form expression + sound + break
const JOKE =
  '<expr type="expression" label="say playfully"/> Why did the burger go to the gym? ' +
  '<expr type="break" label="500ms"/> Because it wanted better buns! ' +
  '<expr type="sound" label="laugh"/>';

describe('convertMarkup: expr -> xAI (sounds, breaks, wrapping prosody; no expression)', () => {
  it('lowers sounds, breaks, and wrapping prosody to native syntax', () => {
    const text =
      'So I walked in and <expr type="break" label="500ms"/> there it was! ' +
      '<expr type="sound" label="laugh"/> ' +
      '<expr type="prosody" label="whisper">It was a secret the whole time.</expr>';
    expect(convertMarkup('xai', text)).toBe(
      'So I walked in and [pause] there it was! [laugh] ' +
        '<whisper>It was a secret the whole time.</whisper>',
    );
  });

  it('maps break durations to the two pause levels', () => {
    expect(convertMarkup('xai', '<expr type="break" label="50ms"/>')).toBe('[pause]');
    expect(convertMarkup('xai', '<expr type="break" label="2s"/>')).toBe('[long-pause]');
  });

  it('maps sound label aliases to native cue names', () => {
    // tolerance: an Inworld-style "breathe" label maps to xAI's native [breath] cue
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

  it('drops expression markers', () => {
    // xAI has no free-form delivery descriptions; a hallucinated expression marker is
    // dropped from the audio path (it still surfaces in transcript tags)
    const text = '<expr type="expression" label="say playfully"/> Hello!';
    expect(convertMarkup('xai', text)).toBe(' Hello!');
  });
});

describe('convertMarkup: expr -> Inworld (free-form expression, its sound list, breaks)', () => {
  it('lowers expression/sound to bracket syntax, break stays native SSML', () => {
    expect(convertMarkup('inworld', JOKE)).toBe(
      '[say playfully] Why did the burger go to the gym? ' +
        '<break time="500ms"/> Because it wanted better buns! [laugh]',
    );
  });

  it('salvages a stray prosody wrapper as an expression hint', () => {
    const text = '<expr type="prosody" label="whisper">keep it secret</expr>';
    expect(convertMarkup('inworld', text)).toBe('[whisper]keep it secret');
  });
});

describe('convertMarkup: expr -> Cartesia (discrete emotions, breaks, spell; no sounds)', () => {
  it('lowers expression to <emotion>, keeps break, drops sound', () => {
    const text =
      '<expr type="expression" label="excited"/> We won! ' +
      '<expr type="break" label="1s"/> <expr type="sound" label="laugh"/> Unbelievable.';
    // expression -> <emotion>, break stays, sound is dropped (no Cartesia support)
    expect(convertMarkup('cartesia', text)).toBe(
      '<emotion value="excited"/> We won! <break time="1s"/>  Unbelievable.',
    );
  });

  it('keeps spell wrapping for Cartesia', () => {
    const text = 'Your code is <expr type="spell">A7X9</expr>.';
    expect(convertMarkup('cartesia', text)).toBe('Your code is <spell>A7X9</spell>.');
  });

  it('unwraps spell for other providers', () => {
    // spell is Cartesia-only; other providers keep the characters, drop the marker
    const text = 'Your code is <expr type="spell">A7X9</expr>.';
    expect(convertMarkup('xai', text)).toBe('Your code is A7X9.');
    expect(convertMarkup('inworld', text)).toBe('Your code is A7X9.');
  });

  it('lowers prosody labels to native point controls', () => {
    // Cartesia prosody labels lower to its native speed/volume ratio tags
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
});

describe('convertMarkup: stray expr markers', () => {
  it('never lets a stray expr marker reach the TTS', () => {
    // an unpaired prosody open/close (e.g. split across stream chunks) is dropped,
    // keeping the words
    expect(convertMarkup('xai', '<expr type="prosody" label="loud">hello there')).toBe(
      'hello there',
    );
    expect(convertMarkup('xai', 'hello there</expr>')).toBe('hello there');
  });
});

describe('transcript stripping (per-provider + provider-agnostic)', () => {
  it.each(['xai', 'inworld', 'cartesia'])('splitMarkup strips expr for %s', (provider) => {
    const [clean, tags] = splitMarkup(provider, JOKE);
    expect(clean.trim()).toBe('Why did the burger go to the gym?  Because it wanted better buns!');
    expect(tags).toEqual([
      { type: 'expression', value: 'say playfully' },
      { type: 'break', value: '500ms' },
      { type: 'sound', value: 'laugh' },
    ]);
  });

  it('keeps the inner text of wrapping markers', () => {
    const text =
      'She said <expr type="prosody" label="whisper">keep it secret</expr> — ' +
      'code <expr type="spell">A7X9</expr>.';
    const [clean, tags] = splitMarkup('xai', text);
    expect(clean).toBe('She said keep it secret — code A7X9.');
    expect(tags).toEqual([
      { type: 'prosody', value: 'whisper' },
      { type: 'spell', value: '' },
    ]);
  });

  it('splitAllMarkup handles mixed expr and native markup', () => {
    const text =
      '<expr type="expression" label="say playfully"/> Hello! <sound value="laugh"/> [sigh]';
    const [clean, tags] = splitAllMarkup(text);
    expect(clean.trim()).toBe('Hello!');
    expect(tags).toContainEqual({ type: 'expression', value: 'say playfully' });
    expect(tags).toContainEqual({ type: 'sound', value: 'laugh' });
    expect(tags).toContainEqual({ type: '', value: 'sigh' });
  });

  it('does not match the native <expression> tag with the expr regexes', () => {
    // "<expr" is a prefix of "<expression" — the word boundary in the expr regexes
    // must keep the native Inworld tag on the generic strip path with its own type
    const text = '<expression value="speak calmly"/> Hi <expr type="break" label="1s"/> there.';
    const [clean, tags] = splitMarkup('inworld', text);
    expect(clean).toBe(' Hi  there.');
    expect(tags).toContainEqual({ type: 'expression', value: 'speak calmly' });
    expect(tags).toContainEqual({ type: 'break', value: '1s' });
    // conversion must also leave the native tag for the provider pipeline, not eat it
    expect(convertMarkup('inworld', text)).toBe('[speak calmly] Hi <break time="1s"/> there.');
  });

  it('TranscriptMarkupStripper handles expr split across streaming chunks', () => {
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
    expect(out).toBe(' Hello world!');
    expect(stripper.tags[0]).toEqual({ type: 'expression', value: 'say playfully' });
    expect(stripper.tags).toContainEqual({ type: 'prosody', value: 'whisper' });
  });

  it('expressionAttribute surfaces the expr expression label', () => {
    const [, tags] = splitMarkup('inworld', JOKE);
    const attr = expressionAttribute(tags);
    expect(attr).toBeDefined();
    expect(Object.values(attr!)[0]).toContain('"say playfully"');
  });
});

describe('normalizeMarkup: fix unclosed self-closing expr markers', () => {
  it.each(['xai', 'inworld', 'cartesia'])('closes an unclosed expr marker for %s', (provider) => {
    const text = '<expr type="sound" label="laugh"> Hello';
    expect(normalizeMarkup(provider, text)).toBe('<expr type="sound" label="laugh"/> Hello');
  });

  it('leaves wrapping and closed markers alone', () => {
    const text =
      '<expr type="prosody" label="whisper">hi</expr> <expr type="break" label="1s"/> ' +
      '<expr type="spell">A7X9</expr>';
    expect(normalizeMarkup('xai', text)).toBe(text);
  });
});

describe('llm instructions: shared syntax, per-provider kinds and vocabularies', () => {
  it.each(['xai', 'inworld', 'cartesia'])('uses expr syntax for %s', (provider) => {
    const instructions = llmInstructions(provider);
    expect(instructions).toBeDefined();
    expect(instructions).toContain('<expr');
    expect(instructions).toContain('<expr type="break" label="');
  });

  it('advertises Cartesia types', () => {
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

  it('advertises Inworld kinds', () => {
    const instructions = llmInstructions('inworld')!;
    // free-form delivery descriptions + Inworld's own sound list
    expect(instructions).toContain('<expr type="expression" label="DESCRIPTION"/>');
    expect(instructions).toContain('free-form');
    expect(instructions).toContain('clear throat');
    // no wrapping prosody, no spell
    expect(instructions).not.toContain('type="prosody"');
    expect(instructions).not.toContain('type="spell"');
  });

  it('advertises xAI kinds', () => {
    const instructions = llmInstructions('xai')!;
    // xAI's own sound cues + wrapping prosody vocabulary
    expect(instructions).toContain('tongue-click');
    expect(instructions).toContain('<expr type="prosody" label="STYLE">');
    expect(instructions).toContain('sing-song');
    // no free-form delivery descriptions, no spell
    expect(instructions).not.toContain('type="expression"');
    expect(instructions).not.toContain('type="spell"');
  });

  it('returns undefined for unknown providers', () => {
    expect(llmInstructions('')).toBeUndefined();
    expect(llmInstructions('openai')).toBeUndefined();
  });
});
