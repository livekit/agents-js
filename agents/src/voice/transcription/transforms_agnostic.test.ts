// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { ReadableStream } from 'node:stream/web';
import { describe, expect, it } from 'vitest';
import {
  filterEmoji,
  filterMarkdown,
  formatEmails,
  formatPhoneNumbers,
  formatTimes,
  removeAngleBracketContent,
  replaceNewlinesWithPeriods,
} from './transforms_agnostic.js';

/**
 * Helper to apply a transform and get the result
 */
async function applyTransform(
  transform: (text: ReadableStream<string>) => ReadableStream<string>,
  input: string,
): Promise<string> {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(input);
      controller.close();
    },
  });

  const result = transform(stream);
  const reader = result.getReader();
  let output = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    output += value;
  }
  return output;
}

describe('filterMarkdown', () => {
  it('should remove headers', async () => {
    const result = await applyTransform(filterMarkdown, '# Header\n## Subheader\n');
    expect(result).toBe('Header\nSubheader\n');
  });

  it('should remove bold asterisks', async () => {
    const result = await applyTransform(filterMarkdown, 'This is **bold** text');
    expect(result).toBe('This is bold text');
  });

  it('should remove italic asterisks', async () => {
    const result = await applyTransform(filterMarkdown, 'This is *italic* text');
    expect(result).toBe('This is italic text');
  });

  it('should remove bold underscores', async () => {
    const result = await applyTransform(filterMarkdown, 'This is __bold__ text');
    expect(result).toBe('This is bold text');
  });

  it('should remove italic underscores', async () => {
    const result = await applyTransform(filterMarkdown, 'This is _italic_ text');
    expect(result).toBe('This is italic text');
  });

  it('should remove inline code', async () => {
    const result = await applyTransform(filterMarkdown, 'Use `console.log()` function');
    expect(result).toBe('Use console.log() function');
  });

  it('should remove code blocks', async () => {
    const result = await applyTransform(filterMarkdown, '```javascript\ncode\n```');
    expect(result).toBe('\ncode\n');
  });

  it('should extract link text', async () => {
    const result = await applyTransform(filterMarkdown, 'Click [here](https://example.com)');
    expect(result).toBe('Click here');
  });

  it('should extract image alt text', async () => {
    const result = await applyTransform(filterMarkdown, '![Logo](logo.png)');
    expect(result).toBe('Logo');
  });

  it('should remove list markers', async () => {
    const result = await applyTransform(filterMarkdown, '- Item 1\n* Item 2\n+ Item 3\n');
    expect(result).toBe('Item 1\nItem 2\nItem 3\n');
  });

  it('should remove block quotes', async () => {
    const result = await applyTransform(filterMarkdown, '> Quote\n');
    expect(result).toBe('Quote\n');
  });

  it('should remove strikethrough', async () => {
    const result = await applyTransform(filterMarkdown, 'This is ~~crossed~~ text');
    expect(result).toBe('This is  text');
  });

  it('should handle complex mixed markdown', async () => {
    const input = '# Title\n\nThis is **bold** and *italic* with `code` and [link](url).';
    const result = await applyTransform(filterMarkdown, input);
    expect(result).not.toContain('**');
    expect(result).not.toContain('*');
    expect(result).not.toContain('`');
    expect(result).not.toContain('[');
    expect(result).not.toContain(']');
    expect(result).toContain('Title');
    expect(result).toContain('bold');
    expect(result).toContain('italic');
    expect(result).toContain('code');
    expect(result).toContain('link');
  });
});

describe('filterEmoji', () => {
  it('should remove emoji', async () => {
    const result = await applyTransform(filterEmoji, 'Hello 👋 World 🌍');
    expect(result).toBe('Hello  World ');
  });

  it('should remove multiple emoji types', async () => {
    const result = await applyTransform(filterEmoji, 'Party 🎉🎊🎈');
    expect(result).toBe('Party ');
  });

  it('should preserve text without emoji', async () => {
    const result = await applyTransform(filterEmoji, 'Hello World');
    expect(result).toBe('Hello World');
  });

  it('should handle text with mixed emoji', async () => {
    const result = await applyTransform(filterEmoji, 'I ❤️ coding 💻 with ☕');
    expect(result).not.toContain('❤');
    expect(result).not.toContain('💻');
    expect(result).not.toContain('☕');
    expect(result).toContain('I');
    expect(result).toContain('coding');
    expect(result).toContain('with');
  });
});

describe('removeAngleBracketContent', () => {
  it('should remove HTML tags', async () => {
    const result = await applyTransform(removeAngleBracketContent, '<div>text</div>');
    expect(result).toBe('text');
  });

  it('should remove multiple tags', async () => {
    const result = await applyTransform(
      removeAngleBracketContent,
      '<p>Hello <strong>World</strong></p>',
    );
    expect(result).toBe('Hello World');
  });

  it('should preserve TTS tags', async () => {
    const result = await applyTransform(removeAngleBracketContent, 'Say <break time="1s"/> this');
    expect(result).toContain('<break');
  });

  it('should preserve text without tags', async () => {
    const result = await applyTransform(removeAngleBracketContent, 'Plain text');
    expect(result).toBe('Plain text');
  });
});

describe('replaceNewlinesWithPeriods', () => {
  it('should replace multiple newlines with period', async () => {
    const result = await applyTransform(replaceNewlinesWithPeriods, 'Line 1\n\nLine 2');
    expect(result).toBe('Line 1. Line 2');
  });

  it('should replace single newlines with space', async () => {
    const result = await applyTransform(replaceNewlinesWithPeriods, 'Line 1\nLine 2');
    expect(result).toBe('Line 1 Line 2');
  });

  it('should handle multiple consecutive newlines', async () => {
    const result = await applyTransform(replaceNewlinesWithPeriods, 'A\n\n\nB');
    expect(result).toBe('A. B');
  });
});

describe('formatEmails', () => {
  it('should format email addresses', async () => {
    const result = await applyTransform(formatEmails, 'Contact: john.doe@example.com');
    expect(result).toContain('john dot doe at example dot com');
  });

  it('should handle multiple email addresses', async () => {
    const result = await applyTransform(formatEmails, 'user1@test.com and user2@test.com');
    expect(result).toContain('user1 at test dot com');
    expect(result).toContain('user2 at test dot com');
  });

  it('should preserve non-email text', async () => {
    const result = await applyTransform(formatEmails, 'No email here');
    expect(result).toBe('No email here');
  });
});

describe('formatPhoneNumbers', () => {
  it('should format phone number with dashes', async () => {
    const result = await applyTransform(formatPhoneNumbers, 'Call 555-123-4567');
    expect(result).toContain('5 5 5 1 2 3 4 5 6 7');
  });

  it('should format phone number with parentheses', async () => {
    const result = await applyTransform(formatPhoneNumbers, 'Call (555) 123-4567');
    expect(result).toContain('5 5 5 1 2 3 4 5 6 7');
  });

  it('should format phone number with dots', async () => {
    const result = await applyTransform(formatPhoneNumbers, 'Call 555.123.4567');
    expect(result).toContain('5 5 5 1 2 3 4 5 6 7');
  });

  it('should preserve non-phone text', async () => {
    const result = await applyTransform(formatPhoneNumbers, 'No phone here');
    expect(result).toBe('No phone here');
  });
});

describe('formatTimes', () => {
  it('should simplify times with 00 minutes', async () => {
    const result = await applyTransform(formatTimes, 'Meeting at 14:00');
    expect(result).toBe('Meeting at 14');
  });

  it('should preserve times with non-zero minutes', async () => {
    const result = await applyTransform(formatTimes, 'Meeting at 14:30');
    expect(result).toBe('Meeting at 14:30');
  });

  it('should handle multiple times', async () => {
    const result = await applyTransform(formatTimes, '9:00 to 10:00 or 14:30');
    expect(result).toContain('9 to 10');
    expect(result).toContain('14:30');
  });
});
