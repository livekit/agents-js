// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression tests: sentence tokenizers must handle XML markup correctly.
 *
 * Covers the basic sentence tokenizer (batch + streaming) with the TTS markup tags used
 * in expressive mode (Cartesia, Inworld, xAI, Fish Audio).
 */
import { describe, expect, it } from 'vitest';
import { extractAndStrip } from '../tts/markup_utils.js';
import { sentenceTokenizer } from '../tts/provider_format.js';
import { SentenceTokenizer } from './basic/basic.js';
import { hasUnclosedXmlTags } from './token_stream.js';

const XML_TAG_RE = /<(\/?)([A-Za-z]\w*)[^>]*?(\/?)\s*>/g;

/** If a sentence has `<tag>`, it must also have `</tag>` (not split). */
function assertWrappingTagIntact(sentences: string[], tag: string): void {
  for (const s of sentences) {
    if (s.includes(`<${tag}`) && !s.includes(`</${tag}>`) && !s.includes('/>')) {
      throw new Error(`<${tag}> split across sentences: ${JSON.stringify(sentences)}`);
    }
  }
}

/** No sentence should be purely XML tags with no text content. */
function assertNoTagOnlySentences(sentences: string[]): void {
  for (const s of sentences) {
    if (s.includes('<')) {
      expect(s.replace(XML_TAG_RE, '').trim(), `Tag-only sentence: ${JSON.stringify(s)}`).not.toBe(
        '',
      );
    }
  }
}

async function streamTokenize(tok: SentenceTokenizer, text: string): Promise<string[]> {
  const stream = tok.stream();
  for (const char of text) {
    stream.pushText(char);
  }
  stream.endInput();
  const tokens: string[] = [];
  for await (const ev of stream) {
    tokens.push(ev.token);
  }
  return tokens;
}

describe('extractAndStrip', () => {
  const strip = (text: string, tags: string[]) => extractAndStrip(text, tags)[0];

  it('removes a self-closing tag', () => {
    expect(strip('<emotion value="happy"/> Hello!', ['emotion'])).toBe(' Hello!');
  });

  it('keeps the content of a wrapping tag', () => {
    expect(strip('<spell>A.B.C.</spell> confirmed', ['spell'])).toBe('A.B.C. confirmed');
  });

  it('preserves unrelated tags', () => {
    const text = '<emotion value="happy"/> <custom>keep</custom>';
    expect(strip(text, ['emotion'])).toBe(' <custom>keep</custom>');
  });

  it('is a no-op with an empty tag list', () => {
    const text = '<emotion value="happy"/> Hi';
    expect(strip(text, [])).toBe(text);
  });

  it('never treats square brackets as markup', () => {
    // only XML is markup here — bracket spans reach transcripts as prose/markdown
    const text = 'Press [Enter] <emotion value="happy"/> to open [the docs](https://lk.io)';
    expect(strip(text, ['emotion'])).toBe('Press [Enter] to open [the docs](https://lk.io)');
  });

  it('leaves a single space where a removal would double it', () => {
    // a tag between two spaces must not leave both behind: the transcript would show a
    // double space after the punctuation the tag followed
    expect(strip('Right. <emotion value="sad"/> Anyway.', ['emotion'])).toBe('Right. Anyway.');
    // the space survives when it is the only separator between the words
    expect(strip('Right.<emotion value="sad"/> Anyway.', ['emotion'])).toBe('Right. Anyway.');
    expect(strip('Right. <emotion value="sad"/>Anyway.', ['emotion'])).toBe('Right. Anyway.');
    // trailing: the space may separate words still streaming in, so it is kept
    expect(strip('Right. <emotion value="sad"/>', ['emotion'])).toBe('Right. ');
    // a wrapping tag keeps its content, so nothing is doubled to begin with
    expect(strip('a <spell>b</spell> c', ['spell'])).toBe('a b c');
    // a lone closing tag is a removal too
    expect(strip('a </spell> b', ['spell'])).toBe('a b');
    // newlines are structure, not a doubled separator
    expect(strip('a\n<emotion value="sad"/>\nb', ['emotion'])).toBe('a\n\nb');
  });

  it('reports the stripped tags', () => {
    const [clean, tags] = extractAndStrip('<emotion value="happy"/>hi <spell>A7</spell>', [
      'emotion',
      'spell',
    ]);
    expect(clean).toBe('hi A7');
    expect(tags).toEqual([
      ['emotion', 'happy'],
      ['spell', 'A7'],
    ]);
  });

  it('does not let a self-closing tag swallow a later wrapping span', () => {
    // a self-closing tag has no span, so it must not consume a following </tag>: that
    // recorded the whole swallowed stretch as the first tag's value, which is what
    // reaches clients as lk.expression
    const [clean, tags] = extractAndStrip(
      '<expression value="excited"/> Great! <expression value="sad">oh no</expression>',
      ['expression'],
    );
    expect(clean).toBe(' Great! oh no');
    expect(tags).toEqual([
      ['expression', 'excited'],
      ['expression', 'oh no'],
    ]);
  });

  it('fully removes nested wrapping tags', () => {
    // a single pass strips only the outer tag, so the fixed-point loop is what keeps
    // inner markup from leaking
    const [clean] = extractAndStrip('<excited><loud>no way</loud></excited>', ['excited', 'loud']);
    expect(clean).toBe('no way');
  });
});

describe('batch sentence tokenizer with markup', () => {
  const tok = new SentenceTokenizer({ minSentenceLength: 1, xmlAware: true });

  it('splits sentences separated by expression tags', () => {
    // Regression: a sentence tokenizer refuses to split when <expression .../> sits
    // between sentences because /> confuses its boundary detection. The XML wrapper must
    // strip tags before tokenizing and remap offsets so each tag goes with its sentence.
    const text =
      '<expression value="speak cheerfully"/> Hello and welcome! ' +
      '<expression value="speak with bright energy"/> Great specials today. ' +
      '<expression value="sound excited"/> Try our new sandwich.';
    const sentences = tok.tokenize(text);
    expect(sentences).toHaveLength(3);
    expect(sentences[0]).toContain('<expression value="speak cheerfully"/>');
    expect(sentences[1]).toContain('<expression value="speak with bright energy"/>');
    expect(sentences[2]).toContain('<expression value="sound excited"/>');
    assertNoTagOnlySentences(sentences);
  });

  it('merges a standalone tag with the following text', () => {
    // Regression: a self-closing tag as its own sentence must merge with the next so TTS
    // never receives a tag-only chunk.
    const text = '<expression value="speak firmly"/> I told you already, no changes.';
    assertNoTagOnlySentences(tok.tokenize(text));
  });

  it('keeps a wrapping tag whose inner text has periods intact', () => {
    const text = 'Spell it: <spell>U.S.A.</spell>. Got it?';
    assertWrappingTagIntact(tok.tokenize(text), 'spell');
  });

  it('keeps a wrapping tag containing full sentences intact', () => {
    const text =
      'Read this: <spell>The quick brown fox. The cat sat on the mat.</spell>. ' +
      'Now something else.';
    assertWrappingTagIntact(tok.tokenize(text), 'spell');
  });

  it('handles self-closing, wrapping and break tags in one text', () => {
    const text =
      '<emotion value="excited"/><speed ratio="1.3"/> Great news! ' +
      'The code is <spell>X9Z</spell>. ' +
      '<break time="500ms"/> <emotion value="calm"/> Let me explain.';
    const sentences = tok.tokenize(text);
    assertWrappingTagIntact(sentences, 'spell');
    assertNoTagOnlySentences(sentences);
  });

  it('still splits plain text', () => {
    expect(tok.tokenize('Hello there. How are you? I am fine.').length).toBeGreaterThanOrEqual(2);
  });

  it('emits a tag-only text as a single token', () => {
    expect(tok.tokenize('<emotion value="happy"/>')).toHaveLength(1);
  });

  it('never strands the last character of the final sentence', () => {
    // regression: the sentence splitter reported `length - 1` as the trailing buffer's
    // end offset, and the XML wrapper rebuilds sentences from those offsets — so the
    // last character was remapped into a token of its own and rejoined with a space,
    // shipping "Bye no w" to the TTS on every expressive turn
    const sentences = tok.tokenize('<x/> Hello there world how are you today. <y/> Bye now');
    expect(sentences).toEqual(['<x/> Hello there world how are you today.', '<y/> Bye now']);
  });
});

describe('streaming sentence tokenizer with markup', () => {
  const makeTok = () =>
    new SentenceTokenizer({ minSentenceLength: 1, streamContextLength: 5, xmlAware: true });

  it('holds a tag split across pushes', async () => {
    const stream = makeTok().stream();
    stream.pushText('Hello. <emo');
    stream.pushText('tion value="happy"/> Great!');
    stream.endInput();
    const tokens: string[] = [];
    for await (const ev of stream) tokens.push(ev.token);
    expect(tokens.join(' ')).toContain('<emotion value="happy"/>');
  });

  it('merges inner sentence splits of a wrapping tag', async () => {
    const text =
      'I want to tell you something important now. ' +
      '<outer>The first thing you should know is quite significant. ' +
      'The second thing is equally critical to understand. ' +
      'The third thing wraps up the entire explanation.</outer> ' +
      'That was everything I needed to explain today.';
    assertWrappingTagIntact(await streamTokenize(makeTok(), text), 'outer');
  });

  it('never emits a tag-only chunk', async () => {
    const text =
      '<expression value="speak firmly with a sharp and serious tone"/> ' +
      'I told you already, no changes to the order.';
    assertNoTagOnlySentences(await streamTokenize(makeTok(), text));
  });

  it('emits a tag-only token on flush', async () => {
    // flush()/endInput() must emit tag-only tokens — they could be non-verbal sounds
    // like laughs that produce audio on their own
    const stream = makeTok().stream();
    stream.pushText('<expression value="laugh"/>');
    stream.endInput();
    const tokens: string[] = [];
    for await (const ev of stream) tokens.push(ev.token);
    expect(tokens).toHaveLength(1);
  });

  it('handles a realistic marked-up conversation turn', async () => {
    const text =
      '<emotion value="neutral"/> Thank you for calling. ' +
      'How can I help you today? ' +
      '<break time="500ms"/> ' +
      '<emotion value="empathetic"/> I understand your frustration. ' +
      'Let me look into this for you. ' +
      'Your order number is <spell>A.B.1.2.3.</spell>. ' +
      '<emotion value="confident"/> I found the issue. ' +
      '<speed ratio="0.8"/> The refund will be processed in 3 to 5 business days. ' +
      '<emotion value="happy"/> Is there anything else I can help with?';
    const tokens = await streamTokenize(makeTok(), text);
    assertWrappingTagIntact(tokens, 'spell');
    assertNoTagOnlySentences(tokens);
  });
});

describe('plain text with "<" (false-positive guard)', () => {
  // Regression: a stray "<" in plain text must not stall streaming. hasUnclosedXmlTags
  // used to treat any "<" after the last ">" as an unfinished tag; one "3 < 5" then held
  // every following sentence until flush, degrading streaming TTS to end-of-turn batching
  // for the rest of the turn.

  it('does not treat a bare "<" as a tag', () => {
    expect(hasUnclosedXmlTags('3 < 5.')).toBe(false);
    expect(hasUnclosedXmlTags('i <3 you')).toBe(false);
    expect(hasUnclosedXmlTags('price < 10 dollars')).toBe(false);
    // tag-shaped: must still hold
    expect(hasUnclosedXmlTags('Hello <emo')).toBe(true);
    expect(hasUnclosedXmlTags('Hello <')).toBe(true); // the next chunk resolves it
    expect(hasUnclosedXmlTags('<spell>abc')).toBe(true); // unclosed wrapping tag
  });

  it('does not count digit-named pseudo tags', () => {
    // regression: the depth-counter regex must not treat "<5>" / "<3 wins>" as open tags,
    // or a complete-but-digit-named pair would leave depth > 0 and stall streaming for
    // the rest of the turn (the tail check already treats "<"+digit as plain text — the
    // two predicates must agree)
    expect(hasUnclosedXmlTags('Rate this from <1> to <5> please.')).toBe(false);
    expect(hasUnclosedXmlTags('Scores: <3 wins> today.')).toBe(false);
    // a real letter-named tag pair is still balanced
    expect(hasUnclosedXmlTags('<spell>abc</spell> done')).toBe(false);
  });

  it('streams a digit pseudo tag with xmlAware on', async () => {
    const stream = new SentenceTokenizer({
      minSentenceLength: 1,
      streamContextLength: 5,
      xmlAware: true,
    }).stream();
    stream.pushText('Rate this from <1> to <5>. And here is a second sentence to split.');
    const { value } = await stream.next();
    expect(value!.token.includes('<5>') || value!.token.includes('<1>')).toBe(true);
    stream.endInput();
  });

  it('streams a bare "<" with xmlAware on', async () => {
    const stream = new SentenceTokenizer({
      minSentenceLength: 1,
      streamContextLength: 5,
      xmlAware: true,
    }).stream();
    stream.pushText('Note that 3 < 5 holds. And here is a second sentence to tokenize.');
    // the first sentence must be emitted without waiting for flush
    const { value } = await stream.next();
    expect(value!.token).toContain('3 < 5');
    stream.endInput();
  });

  it('streams tag-shaped text when xmlAware is off', async () => {
    // the default tokenizer (non-expressive agents) applies no XML logic at all, so even
    // tag-shaped plain text must stream sentence by sentence
    const stream = new SentenceTokenizer({
      minSentenceLength: 1,
      streamContextLength: 5,
    }).stream();
    stream.pushText('Email me at <bob@example.com> please. Second sentence for the split.');
    const { value } = await stream.next();
    expect(value!.token).toContain('bob@example.com');
    stream.endInput();
  });
});

describe('expressive streaming end to end', () => {
  it('sends the turn to the TTS with its words intact', async () => {
    // the whole point of the expressive tokenizer: markers ride with their sentence and
    // no word is mangled on the way to synthesis
    const stream = sentenceTokenizer('inworld', { expressive: true }).stream();
    const turn =
      '<expr type="expression" label="a"/> Welcome to the hotel and thanks for calling us today. ' +
      '<expr type="expression" label="b"/> How can I help?';
    stream.pushText(turn);
    stream.endInput();

    const tokens: string[] = [];
    for await (const ev of stream) tokens.push(ev.token);
    expect(tokens.join(' ')).toBe(turn);
  });
});

describe('token batching', () => {
  it('batches sentences up to minTokenLength and caps at maxTokenLength', async () => {
    // expressive raises the minimum so consecutive sentences ride one request, keeping
    // prosody continuous; the cap still bounds every emitted chunk
    const stream = new SentenceTokenizer({
      minSentenceLength: 1,
      streamContextLength: 5,
      minTokenLength: 60,
      maxTokenLength: 80,
    }).stream();
    stream.pushText('One two three. Four five six. Seven eight nine. Ten eleven twelve. Done.');
    stream.endInput();

    const tokens: string[] = [];
    for await (const ev of stream) tokens.push(ev.token);

    expect(tokens.length).toBeGreaterThan(1);
    for (const token of tokens) {
      expect(token.length).toBeLessThanOrEqual(80);
    }
    // batching happened: at least one chunk carries more than one sentence
    expect(tokens.some((t) => t.split('.').length > 2)).toBe(true);
  });
});
