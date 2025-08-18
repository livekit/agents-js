// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { getUnicodeCategory, normalizeText } from './utils.js';

describe('getUnicodeCategory', () => {
  it('should identify basic ASCII punctuation', () => {
    expect(getUnicodeCategory('!')).toBe('P');
    expect(getUnicodeCategory('"')).toBe('P');
    expect(getUnicodeCategory('#')).toBe('P');
    expect(getUnicodeCategory('$')).toBe('P');
    expect(getUnicodeCategory('%')).toBe('P');
    expect(getUnicodeCategory('&')).toBe('P');
    expect(getUnicodeCategory("'")).toBe('P');
    expect(getUnicodeCategory('(')).toBe('P');
    expect(getUnicodeCategory(')')).toBe('P');
    expect(getUnicodeCategory('*')).toBe('P');
    expect(getUnicodeCategory('+')).toBe('P');
    expect(getUnicodeCategory(',')).toBe('P');
    expect(getUnicodeCategory('-')).toBe('P');
    expect(getUnicodeCategory('.')).toBe('P');
    expect(getUnicodeCategory('/')).toBe('P');
  });

  it('should identify colon/semicolon punctuation', () => {
    expect(getUnicodeCategory(':')).toBe('P');
    expect(getUnicodeCategory(';')).toBe('P');
    expect(getUnicodeCategory('<')).toBe('P');
    expect(getUnicodeCategory('=')).toBe('P');
    expect(getUnicodeCategory('>')).toBe('P');
    expect(getUnicodeCategory('?')).toBe('P');
    expect(getUnicodeCategory('@')).toBe('P');
  });

  it('should identify bracket punctuation', () => {
    expect(getUnicodeCategory('[')).toBe('P');
    expect(getUnicodeCategory('\\')).toBe('P');
    expect(getUnicodeCategory(']')).toBe('P');
    expect(getUnicodeCategory('^')).toBe('P');
    expect(getUnicodeCategory('_')).toBe('P');
    expect(getUnicodeCategory('`')).toBe('P');
  });

  it('should identify brace punctuation', () => {
    expect(getUnicodeCategory('{')).toBe('P');
    expect(getUnicodeCategory('|')).toBe('P');
    expect(getUnicodeCategory('}')).toBe('P');
    expect(getUnicodeCategory('~')).toBe('P');
  });

  it('should identify extended punctuation', () => {
    expect(getUnicodeCategory('¡')).toBe('P');
    expect(getUnicodeCategory('¿')).toBe('P');
    expect(getUnicodeCategory('«')).toBe('P');
    expect(getUnicodeCategory('»')).toBe('P');
  });

  it('should not identify letters as punctuation', () => {
    expect(getUnicodeCategory('a')).toBe('');
    expect(getUnicodeCategory('A')).toBe('');
    expect(getUnicodeCategory('z')).toBe('');
    expect(getUnicodeCategory('Z')).toBe('');
  });

  it('should not identify numbers as punctuation', () => {
    expect(getUnicodeCategory('0')).toBe('');
    expect(getUnicodeCategory('1')).toBe('');
    expect(getUnicodeCategory('9')).toBe('');
  });

  it('should not identify whitespace as punctuation', () => {
    expect(getUnicodeCategory(' ')).toBe('');
    expect(getUnicodeCategory('\t')).toBe('');
    expect(getUnicodeCategory('\n')).toBe('');
  });

  it('should handle empty string', () => {
    expect(getUnicodeCategory('')).toBe('');
  });

  it('should handle unicode characters', () => {
    expect(getUnicodeCategory('é')).toBe('');
    expect(getUnicodeCategory('ñ')).toBe('');
    expect(getUnicodeCategory('ç')).toBe('');
  });
});

describe('normalizeText', () => {
  describe('basic functionality', () => {
    it('should convert to lowercase', () => {
      expect(normalizeText('HELLO')).toBe('hello');
      expect(normalizeText('HeLLo')).toBe('hello');
      expect(normalizeText('WORLD')).toBe('world');
    });

    it('should remove basic punctuation', () => {
      expect(normalizeText('Hello!')).toBe('hello');
      expect(normalizeText('Hello?')).toBe('hello');
      expect(normalizeText('Hello.')).toBe('hello');
      expect(normalizeText('Hello,')).toBe('hello');
    });

    it('should preserve apostrophes', () => {
      expect(normalizeText("I'm happy")).toBe("i'm happy");
      expect(normalizeText("don't worry")).toBe("don't worry");
      expect(normalizeText("it's great")).toBe("it's great");
    });

    it('should preserve hyphens', () => {
      expect(normalizeText('well-trained')).toBe('well-trained');
      expect(normalizeText('state-of-the-art')).toBe('state-of-the-art');
      expect(normalizeText('co-worker')).toBe('co-worker');
    });

    it('should collapse multiple whitespace', () => {
      expect(normalizeText('hello    world')).toBe('hello world');
      expect(normalizeText('multiple   spaces   here')).toBe('multiple spaces here');
      expect(normalizeText('tab\t\tspaces')).toBe('tab spaces');
      expect(normalizeText('newline\n\nspaces')).toBe('newline spaces');
    });

    it('should trim leading and trailing whitespace', () => {
      expect(normalizeText('  hello  ')).toBe('hello');
      expect(normalizeText('\t\nhello\t\n')).toBe('hello');
      expect(normalizeText('   hello world   ')).toBe('hello world');
    });
  });

  describe('comprehensive test cases', () => {
    it('should handle the basic greeting case', () => {
      expect(normalizeText('Hi, how can I help you today?')).toBe('hi how can i help you today');
    });

    it('should handle contractions and hyphens', () => {
      expect(normalizeText("I'm a well-trained assistant!")).toBe("i'm a well-trained assistant");
    });

    it('should remove various punctuation types', () => {
      expect(normalizeText('Hello!!! What??? Price: $19.99 (20% off).')).toBe(
        'hello what price 1999 20 off',
      );
    });

    it('should handle multiple spaces', () => {
      expect(normalizeText('Multiple    spaces   here')).toBe('multiple spaces here');
    });

    it('should handle unicode characters', () => {
      expect(normalizeText('Café entrées naïve résumé')).toBe('café entrées naïve résumé');
    });

    it('should handle mixed punctuation and unicode', () => {
      expect(normalizeText('¿Cómo estás? ¡Muy bien!')).toBe('cómo estás muy bien');
    });
  });

  describe('edge cases', () => {
    it('should handle empty string', () => {
      expect(normalizeText('')).toBe('');
    });

    it('should handle whitespace-only string', () => {
      expect(normalizeText('   ')).toBe('');
      expect(normalizeText('\t\n  ')).toBe('');
    });

    it('should handle punctuation-only string', () => {
      expect(normalizeText('!!!')).toBe('');
      expect(normalizeText('???')).toBe('');
      expect(normalizeText('...')).toBe('');
    });

    it('should handle mixed punctuation and preserved characters', () => {
      expect(normalizeText('!@#$%^&*()_+-={}[]|\\:;"\'<>?,./')).toBe("-'");
    });

    it('should handle numbers with punctuation', () => {
      expect(normalizeText('$19.99')).toBe('1999');
      expect(normalizeText('(555) 123-4567')).toBe('555 123-4567');
    });

    it('should handle special unicode punctuation', () => {
      expect(normalizeText('Hello… world!')).toBe('hello world');
      expect(normalizeText('"Quoted text"')).toBe('quoted text');
      expect(normalizeText("'Single quotes'")).toBe("'single quotes'");
    });
  });

  describe('unicode normalization', () => {
    it('should apply NFKC normalization', () => {
      expect(normalizeText('café')).toBe('café');
      expect(normalizeText('naïve')).toBe('naïve');
    });

    it('should handle combining characters', () => {
      const eWithCombiningAcute = 'caf\u0065\u0301';
      const precomposedE = 'café';
      expect(normalizeText(eWithCombiningAcute)).toBe(normalizeText(precomposedE));
    });
  });

  describe('real-world examples', () => {
    it('should handle typical assistant responses', () => {
      expect(normalizeText('Hello! How can I assist you today?')).toBe(
        'hello how can i assist you today',
      );
      expect(normalizeText("I'm here to help with any questions you might have.")).toBe(
        "i'm here to help with any questions you might have",
      );
    });

    it('should handle typical user queries', () => {
      expect(normalizeText("What's the weather like?")).toBe("what's the weather like");
      expect(normalizeText('Can you help me with my order?')).toBe('can you help me with my order');
      expect(normalizeText('I need assistance, please!')).toBe('i need assistance please');
    });

    it('should handle incomplete sentences', () => {
      expect(normalizeText('What is the weather in')).toBe('what is the weather in');
      expect(normalizeText('I am looking for')).toBe('i am looking for');
      expect(normalizeText('Could you please')).toBe('could you please');
    });

    it('should handle multilingual text', () => {
      expect(normalizeText('Bonjour! Comment ça va?')).toBe('bonjour comment ça va');
      expect(normalizeText('¡Hola! ¿Cómo estás?')).toBe('hola cómo estás');
      expect(normalizeText('Guten Tag! Wie geht es Ihnen?')).toBe('guten tag wie geht es ihnen');
    });
  });
});
