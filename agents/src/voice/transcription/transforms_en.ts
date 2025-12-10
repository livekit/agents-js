// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { ReadableStream } from 'node:stream/web';
import type { TextTransform } from './transforms.js';

/**
 * Number to word mappings for 0-99
 */
const NUMBER_TO_WORDS: Record<number, string> = {
  0: 'zero',
  1: 'one',
  2: 'two',
  3: 'three',
  4: 'four',
  5: 'five',
  6: 'six',
  7: 'seven',
  8: 'eight',
  9: 'nine',
  10: 'ten',
  11: 'eleven',
  12: 'twelve',
  13: 'thirteen',
  14: 'fourteen',
  15: 'fifteen',
  16: 'sixteen',
  17: 'seventeen',
  18: 'eighteen',
  19: 'nineteen',
  20: 'twenty',
  30: 'thirty',
  40: 'forty',
  50: 'fifty',
  60: 'sixty',
  70: 'seventy',
  80: 'eighty',
  90: 'ninety',
};

function numberToWords(num: number): string {
  const word = NUMBER_TO_WORDS[num];
  if (word) {
    return word;
  }
  if (num < 100) {
    const tens = Math.floor(num / 10) * 10;
    const ones = num % 10;
    const tensWord = NUMBER_TO_WORDS[tens];
    const onesWord = NUMBER_TO_WORDS[ones];
    if (tensWord && onesWord) {
      return `${tensWord}-${onesWord}`;
    }
  }
  return num.toString();
}

/**
 * Format numbers in text for TTS
 *
 * - Small numbers (0-99) → words
 * - Years (1900-2099) → preserved as numbers
 * - Large numbers → preserved
 * - Decimals → "X point Y Z..." (individual digits after decimal)
 * - Removes commas from numbers
 */
export const formatNumbers: TextTransform = (
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

          // Remove commas from numbers
          processed = processed.replace(/(\d+),(\d+)/g, '$1$2');

          // Format numbers
          processed = processed.replace(/\b(\d+)\.(\d+)\b/g, (match, whole, decimal) => {
            const wholeNum = parseInt(whole, 10);
            // Don't format years
            if (wholeNum >= 1900 && wholeNum <= 2099) {
              return match;
            }

            const wholePart = wholeNum <= 99 ? numberToWords(wholeNum) : wholeNum.toString();
            const decimalPart = decimal.split('').join(' ');
            return `${wholePart} point ${decimalPart}`;
          });

          // Format whole numbers
          processed = processed.replace(/\b(\d+)\b/g, (match) => {
            const num = parseInt(match, 10);
            // Don't format years or large numbers
            if ((num >= 1900 && num <= 2099) || num > 99) {
              return match;
            }
            return numberToWords(num);
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
 * Format dollar amounts for TTS
 *
 * Examples:
 * - "$5" → "five dollars"
 * - "$12.50" → "twelve dollars and fifty cents"
 * - "$1" → "one dollar" (singular)
 */
export const formatDollarAmounts: TextTransform = (
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

          const processed = value.replace(/\$(\d+)(?:\.(\d+))?/g, (match, dollars, cents) => {
            const dollarNum = parseInt(dollars, 10);
            const dollarWord = dollarNum <= 99 ? numberToWords(dollarNum) : dollarNum.toString();
            const dollarUnit = dollarNum === 1 ? 'dollar' : 'dollars';

            if (cents) {
              const centsNum = parseInt(cents, 10);
              const centsWord = centsNum <= 99 ? numberToWords(centsNum) : centsNum.toString();
              const centsUnit = centsNum === 1 ? 'cent' : 'cents';
              return `${dollarWord} ${dollarUnit} and ${centsWord} ${centsUnit}`;
            }

            return `${dollarWord} ${dollarUnit}`;
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
 * Format percentages for TTS
 *
 * Example: "67%" → "67 percent"
 */
export const formatPercentages: TextTransform = (
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

          const processed = value.replace(/(\d+(?:\.\d+)?)%/g, '$1 percent');
          controller.enqueue(processed);
        }
      } catch (error) {
        controller.error(error);
      }
    },
  });
};

/**
 * Format distance measurements for TTS
 *
 * Examples:
 * - "5 km" → "5 kilometers"
 * - "10 mi" → "10 miles"
 * - "3.5 m" → "3.5 meters"
 */
export const formatDistances: TextTransform = (
  text: ReadableStream<string>,
): ReadableStream<string> => {
  const unitMap: Record<string, string> = {
    km: 'kilometers',
    mi: 'miles',
    m: 'meters',
    ft: 'feet',
    yd: 'yards',
  };

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

          // Remove commas from numbers
          processed = processed.replace(/(\d+),(\d+)/g, '$1$2');

          // Format distances
          for (const [abbrev, full] of Object.entries(unitMap)) {
            const pattern = new RegExp(`\\b(\\d+(?:\\.\\d+)?)\\s*${abbrev}\\b`, 'gi');
            processed = processed.replace(pattern, `$1 ${full}`);
          }

          controller.enqueue(processed);
        }
      } catch (error) {
        controller.error(error);
      }
    },
  });
};

/**
 * Format weight and volume units for TTS
 *
 * Examples:
 * - "10 kg" → "ten kilograms"
 * - "2.5 lb" → "2.5 pounds"
 * - "500 ml" → "500 milliliters"
 */
export const formatUnits: TextTransform = (
  text: ReadableStream<string>,
): ReadableStream<string> => {
  const unitMap: Record<string, string> = {
    lb: 'pounds',
    lbs: 'pounds',
    oz: 'ounces',
    kg: 'kilograms',
    g: 'grams',
    mg: 'milligrams',
    l: 'liters',
    ml: 'milliliters',
    gal: 'gallons',
  };

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

          // Format units
          for (const [abbrev, full] of Object.entries(unitMap)) {
            const pattern = new RegExp(`\\b(\\d+)\\s*${abbrev}\\b`, 'gi');
            processed = processed.replace(pattern, (match, num) => {
              const number = parseInt(num, 10);
              const word = number <= 99 ? numberToWords(number) : num;
              return `${word} ${full}`;
            });
          }

          controller.enqueue(processed);
        }
      } catch (error) {
        controller.error(error);
      }
    },
  });
};

/**
 * Format dates for TTS
 *
 * Example: "2024-12-25" → "Wednesday, December 25, 2024"
 */
export const formatDates: TextTransform = (
  text: ReadableStream<string>,
): ReadableStream<string> => {
  const monthNames = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ];

  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

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

          const processed = value.replace(
            /\b(\d{4})-(\d{2})-(\d{2})\b/g,
            (match, year, month, day) => {
              try {
                const date = new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
                const dayName = dayNames[date.getDay()];
                const monthName = monthNames[date.getMonth()];
                return `${dayName}, ${monthName} ${parseInt(day)}, ${year}`;
              } catch {
                return match; // Return original if parsing fails
              }
            },
          );

          controller.enqueue(processed);
        }
      } catch (error) {
        controller.error(error);
      }
    },
  });
};

/**
 * Common acronyms that should be spoken as words
 */
const KNOWN_ACRONYMS = new Set([
  'NASA',
  'NATO',
  'UNICEF',
  'UNESCO',
  'SCUBA',
  'RADAR',
  'LASER',
  'API',
  'SDK',
  'JSON',
  'XML',
  'HTML',
  'CSS',
  'HTTP',
  'HTTPS',
  'FTP',
  'SQL',
  'URL',
  'URI',
  'PDF',
  'JPG',
  'JPEG',
  'PNG',
  'GIF',
  'MP3',
  'MP4',
  'CPU',
  'GPU',
  'RAM',
  'ROM',
  'SSD',
  'HDD',
  'USB',
  'DVD',
  'CD',
  'AI',
  'ML',
  'VR',
  'AR',
]);

/**
 * Format acronyms for TTS
 *
 * - Known acronyms (NASA, API, etc.) → lowercase
 * - Acronyms with vowels → lowercase
 * - Consonant-only acronyms → space-separated letters
 *
 * Example: "XYZ" → "X Y Z", "NASA" → "nasa"
 */
export const formatAcronyms: TextTransform = (
  text: ReadableStream<string>,
): ReadableStream<string> => {
  const vowels = new Set(['A', 'E', 'I', 'O', 'U']);

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

          const processed = value.replace(/\b[A-Z]{2,}\b/g, (match) => {
            // Known acronyms -> lowercase
            if (KNOWN_ACRONYMS.has(match)) {
              return match.toLowerCase();
            }

            // Has vowels -> lowercase
            const hasVowel = match.split('').some((char) => vowels.has(char));
            if (hasVowel) {
              return match.toLowerCase();
            }

            // Consonants only -> space-separated
            return match.split('').join(' ');
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
 * Registry of all English-specific transforms
 */
export const englishTransforms = new Map<string, TextTransform>([
  ['format_numbers', formatNumbers],
  ['format_dollar_amounts', formatDollarAmounts],
  ['format_percentages', formatPercentages],
  ['format_distances', formatDistances],
  ['format_units', formatUnits],
  ['format_dates', formatDates],
  ['format_acronyms', formatAcronyms],
]);
