// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { isInstructions } from '../llm/chat_context.js';
import { DEFAULT_EXPRESSIVE_OPTIONS } from '../voice/agent_session.js';
import * as presets from '../voice/presets.js';
import {
  TranscriptMarkupStripper,
  convertMarkup,
  expressionAttribute,
  llmInstructions,
  normalizeMarkup,
  splitAllMarkup,
  splitMarkup,
} from './_provider_format.js';
import { stripXmlTags } from './markup_utils.js';
import { type TTS, TTSMarkup } from './tts.js';

async function* chunks(items: string[]): AsyncGenerator<string, void, void> {
  for (const it of items) {
    yield it;
  }
}

async function collect(gen: AsyncGenerator<string, void, void>): Promise<string[]> {
  const out: string[] = [];
  for await (const chunk of gen) {
    out.push(chunk);
  }
  return out;
}

describe('stripXmlTags', () => {
  it('removes self-closing tags entirely', () => {
    expect(stripXmlTags('<emotion value="happy"/> Hello!', ['emotion'])).toBe(' Hello!');
  });

  it('preserves the content of wrapping tags', () => {
    expect(stripXmlTags('<spell>A.B.C.</spell> confirmed', ['spell'])).toBe('A.B.C. confirmed');
  });

  it('preserves unrelated tags', () => {
    const text = '<emotion value="happy"/> <custom>keep</custom>';
    expect(stripXmlTags(text, ['emotion'])).toBe(' <custom>keep</custom>');
  });

  it('is a no-op with an empty tags list', () => {
    const text = '<emotion value="happy"/> Hi';
    expect(stripXmlTags(text, [])).toBe(text);
  });
});

describe('xAI dialect', () => {
  // xAI's LLM writes every tag as XML — inline sounds as <sound value="NAME"/> and pauses
  // as <break time="..."/> (modeled on Inworld); the transcript strips them all, and
  // convertMarkup rewrites sounds to [NAME] and <break> to [pause]/[long-pause] for the
  // TTS while prosody/style stay angle-bracketed.

  it('registers LLM instructions', () => {
    const instr = llmInstructions('xai');
    // non-undefined is what the expressive gate keys on
    expect(instr).toBeDefined();
    expect(instr).toContain('<sound value="laugh"/>');
    expect(instr).toContain('<whisper>');
  });

  it('splitMarkup strips inline tags and keeps wrapping inner text', () => {
    const raw =
      'So I walked in and <break time="500ms"/> there it was. <sound value="laugh"/> ' +
      '<whisper>a secret</whisper> <emphasis>wow</emphasis>.';
    const [clean, tags] = splitMarkup('xai', raw);
    // inline sounds/pauses removed entirely; wrapping tags keep their inner text
    expect(clean).not.toContain('<break');
    expect(clean).not.toContain('<sound');
    expect(clean).not.toContain('laugh');
    expect(clean).not.toContain('<whisper>');
    expect(clean).toContain('a secret');
    expect(clean).toContain('wow');
    const types = tags.map((t) => [t.type, t.value]);
    expect(types).toContainEqual(['break', '500ms']);
    expect(types).toContainEqual(['sound', 'laugh']);
    expect(types).toContainEqual(['whisper', 'a secret']);
    expect(types).toContainEqual(['emphasis', 'wow']);
  });

  it('strips emotion wrapping tags but keeps the spoken words', () => {
    const raw = "<happy>Great to hear from you!</happy> <sad>I'm sorry about that.</sad>";
    const [clean, tags] = splitMarkup('xai', raw);
    expect(clean).not.toContain('<happy>');
    expect(clean).not.toContain('</sad>');
    expect(clean).toContain('Great to hear from you!');
    expect(clean).toContain("I'm sorry about that.");
    const types = tags.map((t) => [t.type, t.value]);
    expect(types).toContainEqual(['happy', 'Great to hear from you!']);
    expect(types).toContainEqual(['sad', "I'm sorry about that."]);
  });

  it('strips nested emotion + prosody tags cleanly', () => {
    // combining emotion + prosody means nesting; the transcript must come out clean
    // (no leaked inner markup) — this is what the fixed-point strip guarantees
    const raw =
      '<excited><loud><higher-pitch>no way</higher-pitch></loud></excited> ' +
      '<sound value="laugh"/> okay';
    const [clean] = splitMarkup('xai', raw);
    expect(clean).not.toContain('<');
    expect(clean).not.toContain('>');
    expect(clean).not.toContain('[');
    expect(clean).toContain('no way');
    expect(clean).toContain('okay');
  });

  it('converts inline sounds and pauses to brackets, prosody stays XML', () => {
    const raw =
      '<sound value="laugh"/> <break time="500ms"/> <break time="2s"/> <whisper>hi</whisper>';
    // <sound value="X"/> -> [X]; <break> -> [pause] (<1s) or [long-pause] (>=1s);
    // prosody stays angle-bracketed, and normalize is a no-op for xAI
    expect(convertMarkup('xai', raw)).toBe('[laugh] [pause] [long-pause] <whisper>hi</whisper>');
    expect(normalizeMarkup('xai', raw)).toBe(raw);
  });

  it('resolves presets to xAI-tuned bodies', () => {
    for (const preset of [presets.CUSTOMER_SERVICE, presets.CASUAL]) {
      const opts = presets.resolveOptions(preset, {
        providerKey: 'xai',
        defaultOptions: DEFAULT_EXPRESSIVE_OPTIONS,
      });
      const tmpl = opts.ttsInstructionsTemplate!;
      const body = isInstructions(tmpl) ? tmpl.common : tmpl;
      // tuned body, not the agnostic default (which has no xai tag reference)
      expect(body).toContain('<whisper>');
    }
  });
});

describe('normalizeMarkup', () => {
  it('closes opening tags that should be self-closing', () => {
    expect(normalizeMarkup('inworld', '<expression value="happy"> Hi')).toBe(
      '<expression value="happy"/> Hi',
    );
    expect(normalizeMarkup('cartesia', '<emotion value="calm"> Hello')).toBe(
      '<emotion value="calm"/> Hello',
    );
  });

  it('is a no-op for providers without self-closing tags', () => {
    const text = '<emotion value="happy"> Hi';
    expect(normalizeMarkup('unknown-provider', text)).toBe(text);
  });
});

describe('universal transcript stripping', () => {
  // The transcript sinks strip downstream without knowing the provider, so they remove
  // the union of every provider's tags. See splitAllMarkup / TranscriptMarkupStripper.

  it('splitAllMarkup strips every provider dialect at once', () => {
    // Cartesia <emotion>, Inworld/xAI <expression>/<sound>, and bracket tags all strip
    // regardless of which provider produced them
    const [clean, tags] = splitAllMarkup(
      '<emotion value="happy"/>Hi <expression value="warm"/>there ' +
        '<sound value="giggle"/>[pause] friend',
    );
    expect(clean).toBe('Hi there  friend');
    const types = tags.map((t) => [t.type, t.value]);
    expect(types).toContainEqual(['emotion', 'happy']);
    expect(types).toContainEqual(['expression', 'warm']);
    expect(types).toContainEqual(['sound', 'giggle']);
    expect(types).toContainEqual(['', 'pause']);
  });

  it('expressionAttribute builds the lk.expression attribute', () => {
    let [, tags] = splitAllMarkup('<emotion value="sad"/>oh no');
    expect(expressionAttribute(tags)).toEqual({ 'lk.expression': '{"value":"sad"}' });

    // no expression/emotion tag -> no attribute (bracket sounds don't count)
    [, tags] = splitAllMarkup('[pause]hi');
    expect(expressionAttribute(tags)).toBeUndefined();
  });

  it('TranscriptMarkupStripper holds partial tags across pushes', () => {
    const s = new TranscriptMarkupStripper();
    // a tag split across pushes is held until it closes, never emitted half-stripped
    let out = s.push('Hi <emo');
    out += s.push('tion value="happy"/> the');
    out += s.push('re');
    out += s.flush();
    expect(out).not.toContain('<emotion');
    expect(out.replace(/ /g, '')).toBe('Hithere');
    expect(s.expressionAttribute()).toEqual({ 'lk.expression': '{"value":"happy"}' });
  });

  it('TranscriptMarkupStripper does not stall on a bare "<"', () => {
    const s = new TranscriptMarkupStripper();
    // a bare "<" in prose must not freeze the following chunk
    const first = s.push('The value 3 < 5 ');
    expect(first).toContain('3 < 5');
    const rest = s.push('is true.') + s.flush();
    expect((first + rest).replace(/ /g, '')).toBe('Thevalue3<5istrue.');
  });
});

describe('TTSMarkup.toTextStream', () => {
  // Regression: the transcript-strip path must not stall on a bare "<" either.
  // toTextStream buffered on a naive lastIndexOf("<") > lastIndexOf(">") check, so a
  // "<" in prose (e.g. "3 < 5") froze every following transcript chunk of the segment
  // until a ">" arrived or the stream ended.

  const markup = () =>
    // _markupProviderKey is the only TTS member TTSMarkup uses
    new TTSMarkup({ _markupProviderKey: () => 'cartesia' } as unknown as TTS);

  it('does not hold the following chunk after a bare "<"', async () => {
    const out = await collect(markup().toTextStream(chunks(['The value 3 < 5 ', 'is true.'])));
    // fixed: the first chunk is emitted incrementally (>= 2 items); the buggy
    // version held everything and emitted a single item at end-of-stream
    expect(out.length).toBeGreaterThanOrEqual(2);
    expect(out[0]).toContain('3 < 5');
    expect(out.join('').replace(/ /g, '')).toBe('Thevalue3<5istrue.');
  });

  it('still buffers a genuinely partial tag across chunks', async () => {
    const out = await collect(
      markup().toTextStream(chunks(['Hi <emo', 'tion value="happy"/> there'])),
    );
    const joined = out.join('');
    expect(joined).not.toContain('<emotion');
    expect(joined).toContain('Hi');
    expect(joined).toContain('there');
  });

  it('collects stripped tags into tagsOut', async () => {
    const tagsOut: { type: string; value: string }[] = [];
    const out = await collect(
      markup().toTextStream(chunks(['<emotion value="happy"/>Hello there!']), { tagsOut }),
    );
    expect(out.join('')).toBe('Hello there!');
    expect(tagsOut).toEqual([{ type: 'emotion', value: 'happy' }]);
  });
});
