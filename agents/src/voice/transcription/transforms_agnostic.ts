// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { ReadableStream } from 'node:stream/web';
import type { LanguageAgnosticTransformName, TextTransform } from './transforms.js';

/**
 * Filter out markdown syntax from text
 *
 * Removes common markdown formatting like:
 * - Headers (# text)
 * - List markers (-, *, +)
 * - Bold (**text**, __text__)
 * - Italic (*text*, _text_)
 * - Links ([text](url))
 * - Images (![alt](url))
 * - Code blocks (```code```)
 * - Inline code (`code`)
 * - Strikethrough (~~text~~)
 * - Block quotes (> text)
 */
export const filterMarkdown: TextTransform = (
  text: ReadableStream<string>,
): ReadableStream<string> => {
  // Line-level patterns (applied at start of lines)
  const linePatterns: Array<[RegExp, string]> = [
    [/^#{1,6}\s+/gm, ''], // headers
    [/^\s*[-+*]\s+/gm, ''], // list markers
    [/^\s*>\s+/gm, ''], // block quotes
  ];

  // Inline patterns (applied anywhere in text)
  const inlinePatterns: Array<[RegExp, string]> = [
    [/!\[([^\]]*)\]\([^)]*\)/g, '$1'], // images: keep alt text
    [/\[([^\]]*)\]\([^)]*\)/g, '$1'], // links: keep text
    [/(?<!\S)\*\*([^*]+?)\*\*(?!\S)/g, '$1'], // bold with asterisks
    [/(?<!\S)\*([^*]+?)\*(?!\S)/g, '$1'], // italic with asterisks
    [/(?<!\w)__([^_]+?)__(?!\w)/g, '$1'], // bold with underscores
    [/(?<!\w)_([^_]+?)_(?!\w)/g, '$1'], // italic with underscores
    [/`{3,4}[\S]*/g, ''], // code blocks
    [/`([^`]+?)`/g, '$1'], // inline code: keep content
    [/~~(?!\s)([^~]*?)(?<!\s)~~/g, ''], // strikethrough
  ];

  const splitTokens = new Set([' ', ',', '.', '?', '!', ';', '，', '。', '？', '！', '；']);

  // Patterns to detect incomplete markdown
  const completeLinksPattern = /\[[^\]]*\]\([^)]*\)/g;
  const completeImagesPattern = /!\[[^\]]*\]\([^)]*\)/g;

  function hasIncompletePattern(buffer: string): boolean {
    // Check for incomplete markers at end
    if (/[#\-+*>!`~ ]$/.test(buffer)) {
      return true;
    }

    // Check for unpaired bold/italic asterisks
    const doubleAsterisks = (buffer.match(/\*\*/g) || []).length;
    if (doubleAsterisks % 2 === 1) return true;

    const singleAsterisks = (buffer.match(/\*/g) || []).length - doubleAsterisks * 2;
    if (singleAsterisks % 2 === 1) return true;

    // Check for unpaired underscores
    const doubleUnderscores = (buffer.match(/__/g) || []).length;
    if (doubleUnderscores % 2 === 1) return true;

    const singleUnderscores = (buffer.match(/_/g) || []).length - doubleUnderscores * 2;
    if (singleUnderscores % 2 === 1) return true;

    // Check for unpaired backticks
    const backticks = (buffer.match(/`/g) || []).length;
    if (backticks % 2 === 1) return true;

    // Check for unpaired tildes
    const doubleTildes = (buffer.match(/~~/g) || []).length;
    if (doubleTildes % 2 === 1) return true;

    // Check for incomplete links/images
    const openBrackets = (buffer.match(/\[/g) || []).length;
    const completeLinks = (buffer.match(completeLinksPattern) || []).length;
    const completeImages = (buffer.match(completeImagesPattern) || []).length;

    if (openBrackets - completeLinks - completeImages > 0) {
      return true;
    }

    return false;
  }

  function processCompleteText(textToProcess: string, isNewline: boolean): string {
    let processed = textToProcess;

    if (isNewline) {
      for (const [pattern, replacement] of linePatterns) {
        processed = processed.replace(pattern, replacement);
      }
    }

    for (const [pattern, replacement] of inlinePatterns) {
      processed = processed.replace(pattern, replacement);
    }

    return processed;
  }

  return new ReadableStream({
    async start(controller) {
      let buffer = '';
      let bufferIsNewline = true;

      try {
        const reader = text.getReader();

        while (true) {
          const { done, value } = await reader.read();

          if (done) {
            if (buffer.length > 0) {
              controller.enqueue(processCompleteText(buffer, bufferIsNewline));
            }
            controller.close();
            break;
          }

          buffer += value;

          // Handle newlines
          if (buffer.includes('\n')) {
            const lines = buffer.split('\n');
            buffer = lines[lines.length - 1] || '';

            for (let i = 0; i < lines.length - 1; i++) {
              const isNewline = i === 0 ? bufferIsNewline : true;
              const line = lines[i];
              if (line !== undefined) {
                const processedLine = processCompleteText(line, isNewline);
                controller.enqueue(processedLine + '\n');
              }
            }

            bufferIsNewline = true;
            continue;
          }

          // Find last split token
          let lastSplitPos = -1;
          for (let i = buffer.length - 1; i >= 0; i--) {
            const char = buffer[i];
            if (char && splitTokens.has(char)) {
              lastSplitPos = i;
              break;
            }
          }

          if (lastSplitPos >= 0) {
            const processable = buffer.substring(0, lastSplitPos);
            const rest = buffer.substring(lastSplitPos);

            if (!hasIncompletePattern(processable)) {
              controller.enqueue(processCompleteText(processable, bufferIsNewline));
              buffer = rest;
              bufferIsNewline = false;
            }
          }
        }
      } catch (error) {
        controller.error(error);
      }
    },
  });
};

/**
 * Filter out emoji characters from text
 *
 * Removes emoji characters from Unicode blocks including:
 * - Emoji symbols and pictographs
 * - Miscellaneous symbols
 * - Dingbats
 * - Variation selectors
 * - Zero-width joiners and keycaps
 */
export const filterEmoji: TextTransform = (
  text: ReadableStream<string>,
): ReadableStream<string> => {
  // Unicode emoji pattern covering major emoji blocks
  const emojiPattern =
    /[\u{1F000}-\u{1FBFF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]|[\u{2B00}-\u{2BFF}]|[\u{FE00}-\u{FE0F}]|\u{200D}|\u{20E3}/gu;

  return new ReadableStream({
    async start(controller) {
      try {
        const reader = text.getReader();

        while (true) {
          const { done, value } = await reader.read();

          if (done) {
            controller.close();
            break;
          }

          const filtered = value.replace(emojiPattern, '');
          if (filtered.length > 0) {
            controller.enqueue(filtered);
          }
        }
      } catch (error) {
        controller.error(error);
      }
    },
  });
};

/**
 * Remove HTML-like angle bracket content from text
 *
 * Removes content within angle brackets like <div>text</div>.
 * Preserves special TTS tags like <break>, <spell>, etc.
 */
export const removeAngleBracketContent: TextTransform = (
  text: ReadableStream<string>,
): ReadableStream<string> => {
  // Preserve these TTS-specific tags
  const preservedTags = new Set(['break', 'spell', 'say-as', 'phoneme', 'prosody', 'emphasis']);

  return new ReadableStream({
    async start(controller) {
      try {
        const reader = text.getReader();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();

          if (done) {
            if (buffer.length > 0) {
              controller.enqueue(buffer);
            }
            controller.close();
            break;
          }

          buffer += value;

          // Process complete tags
          let processed = buffer;
          let changed = true;
          while (changed) {
            changed = false;
            const tagMatch = /<\/?([a-zA-Z][a-zA-Z0-9-]*)[^>]*>/;
            const match = processed.match(tagMatch);

            if (match) {
              const [fullMatch, tagName] = match;
              if (tagName && !preservedTags.has(tagName.toLowerCase())) {
                processed = processed.replace(fullMatch, '');
                changed = true;
              } else {
                // Can't process further, need more context
                break;
              }
            }
          }

          // Only emit if we made progress
          if (processed !== buffer) {
            controller.enqueue(processed);
            buffer = '';
          }
        }
      } catch (error) {
        controller.error(error);
      }
    },
  });
};

/**
 * Replace newlines with periods for better TTS flow
 *
 * - Multiple consecutive newlines → ". "
 * - Single newlines → " "
 */
export const replaceNewlinesWithPeriods: TextTransform = (
  text: ReadableStream<string>,
): ReadableStream<string> => {
  return new ReadableStream({
    async start(controller) {
      try {
        const reader = text.getReader();

        while (true) {
          const { done, value } = await reader.read();

          if (done) {
            controller.close();
            break;
          }

          let processed = value;
          // Multiple newlines to period
          processed = processed.replace(/\n{2,}/g, '. ');
          // Single newlines to space
          processed = processed.replace(/\n/g, ' ');

          controller.enqueue(processed);
        }
      } catch (error) {
        controller.error(error);
      }
    },
  });
};

/**
 * Format email addresses for TTS
 *
 * Example: "john.doe@example.com" → "john dot doe at example dot com"
 */
export const formatEmails: TextTransform = (
  text: ReadableStream<string>,
): ReadableStream<string> => {
  const emailPattern = /\b[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}\b/g;

  return new ReadableStream({
    async start(controller) {
      try {
        const reader = text.getReader();

        while (true) {
          const { done, value } = await reader.read();

          if (done) {
            controller.close();
            break;
          }

          const processed = value.replace(emailPattern, (email) => {
            return email.replace(/\./g, ' dot ').replace(/@/g, ' at ');
          });

          controller.enqueue(processed);
        }
      } catch (error) {
        controller.error(error);
      }
    },
  });
};

/**
 * Format phone numbers for TTS
 *
 * Example: "555-123-4567" → "5 5 5 1 2 3 4 5 6 7"
 */
export const formatPhoneNumbers: TextTransform = (
  text: ReadableStream<string>,
): ReadableStream<string> => {
  // Match phone number patterns
  const phonePattern =
    /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b|\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/g;

  return new ReadableStream({
    async start(controller) {
      try {
        const reader = text.getReader();

        while (true) {
          const { done, value } = await reader.read();

          if (done) {
            controller.close();
            break;
          }

          const processed = value.replace(phonePattern, (phone) => {
            // Extract only digits
            const digits = phone.replace(/\D/g, '');
            // Space them out
            return digits.split('').join(' ');
          });

          controller.enqueue(processed);
        }
      } catch (error) {
        controller.error(error);
      }
    },
  });
};

/**
 * Format times for TTS
 *
 * Example: "14:00" → "14" (simplify when minutes are 00)
 * Other times remain unchanged
 */
export const formatTimes: TextTransform = (
  text: ReadableStream<string>,
): ReadableStream<string> => {
  const timePattern = /\b(\d{1,2}):00\b/g;

  return new ReadableStream({
    async start(controller) {
      try {
        const reader = text.getReader();

        while (true) {
          const { done, value } = await reader.read();

          if (done) {
            controller.close();
            break;
          }

          const processed = value.replace(timePattern, '$1');
          controller.enqueue(processed);
        }
      } catch (error) {
        controller.error(error);
      }
    },
  });
};

/**
 * Registry of all language-agnostic transforms
 */
export const languageAgnosticTransforms = new Map<LanguageAgnosticTransformName, TextTransform>([
  ['filter_markdown', filterMarkdown],
  ['filter_emoji', filterEmoji],
  ['remove_angle_bracket_content', removeAngleBracketContent],
  ['replace_newlines_with_periods', replaceNewlinesWithPeriods],
  ['format_emails', formatEmails],
  ['format_phone_numbers', formatPhoneNumbers],
  ['format_times', formatTimes],
]);
