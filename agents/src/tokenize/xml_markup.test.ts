// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression tests: sentence tokenizers must handle XML markup correctly.
 *
 * Covers the basic sentence tokenizer (batch + streaming) with TTS markup tags
 * used in expressive mode (Cartesia, Inworld, xAI).
 */
import { describe, expect, it } from 'vitest';
import { SentenceTokenizer } from './basic/index.js';
import { hasUnclosedXmlTags } from './token_stream.js';
import type { SentenceStream } from './tokenizer.js';

const XML_TAG_RE = /<(\/?)([A-Za-z]\w*)[^>]*?(\/?)\s*>/g;

/** If a sentence has `<tag>`, it must also have `</tag>` (not split). */
function assertWrappingTagIntact(sentences: string[], tag: string): void {
  for (const s of sentences) {
    if (s.includes(`<${tag}`) && !s.includes(`</${tag}>`) && !s.includes('/>')) {
      expect.fail(`<${tag}> split across sentences: ${JSON.stringify(sentences)}`);
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

async function collect(stream: SentenceStream): Promise<string[]> {
  const tokens: string[] = [];
  for await (const ev of stream) {
    tokens.push(ev.token);
  }
  return tokens;
}

/** Push text char-by-char (worst-case chunking) and collect emitted tokens. */
async function streamTokenize(tok: SentenceTokenizer, text: string): Promise<string[]> {
  const stream = tok.stream();
  for (const char of text) {
    stream.pushText(char);
  }
  stream.endInput();
  return collect(stream);
}

/** Await the next stream token, failing if it doesn't arrive without a flush. */
async function nextTokenWithTimeout(stream: SentenceStream, timeoutMs = 1000): Promise<string> {
  const result = await Promise.race([
    stream.next(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('timed out waiting for a token')), timeoutMs),
    ),
  ]);
  if (result.done || !result.value) {
    throw new Error('stream ended without emitting a token');
  }
  return result.value.token;
}

describe('hasUnclosedXmlTags', () => {
  it('does not treat a bare "<" as a tag', () => {
    expect(hasUnclosedXmlTags('3 < 5.')).toBe(false);
    expect(hasUnclosedXmlTags('i <3 you')).toBe(false);
    expect(hasUnclosedXmlTags('price < 10 dollars')).toBe(false);
    // tag-shaped: must still hold
    expect(hasUnclosedXmlTags('Hello <emo')).toBe(true);
    expect(hasUnclosedXmlTags('Hello <')).toBe(true); // the next chunk resolves it
    expect(hasUnclosedXmlTags('<spell>abc')).toBe(true); // unclosed wrapping tag
  });

  it('does not count digit-named pseudo tags as open tags', () => {
    // regression: the depth-counter regex must not treat "<5>" / "<3 wins>" as
    // open tags, or a complete-but-digit-named pair would leave depth > 0 and
    // stall streaming for the rest of the turn
    expect(hasUnclosedXmlTags('Rate this from <1> to <5> please.')).toBe(false);
    expect(hasUnclosedXmlTags('Scores: <3 wins> today.')).toBe(false);
    // a real letter-named tag pair is still balanced
    expect(hasUnclosedXmlTags('<spell>abc</spell> done')).toBe(false);
  });
});

describe('batch sentence tokenizer (xmlAware)', () => {
  const tok = new SentenceTokenizer({ minSentenceLength: 1, xmlAware: true });

  it('splits correctly with expression tags between sentences', () => {
    // Regression: a self-closing tag between sentences must not confuse boundary
    // detection; each tag goes with its own sentence.
    const text =
      '<expression value="speak cheerfully"/> Hello and welcome! ' +
      '<expression value="speak with bright energy"/> Great specials today. ' +
      '<expression value="sound excited"/> Try our new sandwich.';
    const sentences = tok.tokenize(text);
    expect(sentences, `Expected 3 sentences: ${JSON.stringify(sentences)}`).toHaveLength(3);
    expect(sentences[0]).toContain('<expression value="speak cheerfully"/>');
    expect(sentences[1]).toContain('<expression value="speak with bright energy"/>');
    expect(sentences[2]).toContain('<expression value="sound excited"/>');
    assertNoTagOnlySentences(sentences);
  });

  it('merges a standalone tag with the following text', () => {
    // Regression: a self-closing tag as its own sentence must merge with the next
    // so TTS never receives a tag-only chunk.
    const text = '<expression value="speak firmly"/> I told you already, no changes to the order.';
    const sentences = tok.tokenize(text);
    assertNoTagOnlySentences(sentences);
  });

  it('keeps a wrapping tag with inner periods intact', () => {
    // Dots inside <spell> look like sentence endings. Merge must keep tag intact.
    const text = 'Spell it: <spell>U.S.A.</spell>. Got it?';
    const sentences = tok.tokenize(text);
    assertWrappingTagIntact(sentences, 'spell');
  });

  it('keeps full sentences inside a wrapping tag together', () => {
    const text =
      'Read this: <spell>The quick brown fox. The cat sat on the mat.</spell>. ' +
      'Now something else.';
    const sentences = tok.tokenize(text);
    assertWrappingTagIntact(sentences, 'spell');
  });

  it('handles mixed self-closing + wrapping + break tags', () => {
    const text =
      '<emotion value="excited"/><speed ratio="1.3"/> Great news! ' +
      'The code is <spell>X9Z</spell>. ' +
      '<break time="500ms"/> <emotion value="calm"/> Let me explain.';
    const sentences = tok.tokenize(text);
    assertWrappingTagIntact(sentences, 'spell');
    assertNoTagOnlySentences(sentences);
  });

  it('still splits text without markup', () => {
    const sentences = tok.tokenize('Hello there. How are you? I am fine.');
    expect(sentences.length).toBeGreaterThanOrEqual(2);
  });

  it('emits a single token for tag-only input', () => {
    const sentences = tok.tokenize('<emotion value="happy"/>');
    expect(sentences).toHaveLength(1);
  });
});

describe('streaming sentence tokenizer (xmlAware)', () => {
  const tok = new SentenceTokenizer({
    minSentenceLength: 1,
    streamContextLength: 5,
    xmlAware: true,
  });

  it('splits streamed expression tags between sentences', async () => {
    const text =
      '<expression value="speak cheerfully"/> Hello and welcome! ' +
      '<expression value="speak with bright energy"/> We have got some great specials. ' +
      '<expression value="sound excited"/> Our new chicken sandwich is amazing. ' +
      '<expression value="speak warmly"/> Would you like to try a combo meal?';
    const tokens = await streamTokenize(tok, text);
    expect(
      tokens.length,
      `Expected at least 3 sentences: ${JSON.stringify(tokens)}`,
    ).toBeGreaterThanOrEqual(3);
    assertNoTagOnlySentences(tokens);
    for (const t of tokens) {
      expect(t, `Sentence missing expression tag: ${JSON.stringify(t)}`).toContain('<expression');
    }
  });

  it('handles a realistic conversation with mixed markup', async () => {
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
    const tokens = await streamTokenize(tok, text);
    assertWrappingTagIntact(tokens, 'spell');
    assertNoTagOnlySentences(tokens);
  });

  it('never splits mid-word when streamed in small chunks', async () => {
    // Regression: splitSentences reported the final (incomplete) sentence with an
    // off-by-one end offset; xmlWrapTokenizer remapped it onto the original text and
    // split the last character into a phantom sentence, emitting "Hell o!" mid-word.
    const text = `<emotion value="happy"/> Hello! It's great to see you. How can I assist you today?`;
    const stream = tok.stream();
    for (let i = 0; i < text.length; i += 4) {
      stream.pushText(text.slice(i, i + 4));
    }
    stream.endInput();
    const tokens = await collect(stream);
    const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();
    expect(collapse(tokens.join(' '))).toBe(collapse(text));
  });

  it('streams past a bare "<" in plain text without stalling', async () => {
    // Regression: one "3 < 5" used to hold every following sentence until flush,
    // degrading streaming TTS to end-of-turn batching for the rest of the turn.
    const stream = tok.stream();
    stream.pushText('Note that 3 < 5 holds. And here is a second sentence to tokenize.');
    const token = await nextTokenWithTimeout(stream);
    expect(token).toContain('3 < 5');
    stream.endInput();
  });

  it('streams past digit-named pseudo tags', async () => {
    const stream = tok.stream();
    stream.pushText('Rate this from <1> to <5>. And here is a second sentence to split.');
    const token = await nextTokenWithTimeout(stream);
    expect(token.includes('<5>') || token.includes('<1>')).toBe(true);
    stream.endInput();
  });
});

describe('streaming sentence tokenizer (not xmlAware)', () => {
  it('streams tag-shaped plain text sentence by sentence', async () => {
    // the default tokenizer (non-expressive agents) applies no XML logic at all,
    // so even tag-shaped plain text must stream sentence by sentence
    const tok = new SentenceTokenizer({ minSentenceLength: 1, streamContextLength: 5 });
    const stream = tok.stream();
    stream.pushText('Email me at <bob@example.com> please. Second sentence for the split.');
    const token = await nextTokenWithTimeout(stream);
    expect(token).toContain('bob@example.com');
    stream.endInput();
  });
});
