// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { ReadableStream } from 'node:stream/web';
import type { TextTransform } from './transforms.js';

/**
 * Number to word mappings for German (0-99)
 */
const NUMBER_TO_WORDS_DE: Record<number, string> = {
  0: 'null',
  1: 'eins',
  2: 'zwei',
  3: 'drei',
  4: 'vier',
  5: 'fünf',
  6: 'sechs',
  7: 'sieben',
  8: 'acht',
  9: 'neun',
  10: 'zehn',
  11: 'elf',
  12: 'zwölf',
  13: 'dreizehn',
  14: 'vierzehn',
  15: 'fünfzehn',
  16: 'sechzehn',
  17: 'siebzehn',
  18: 'achtzehn',
  19: 'neunzehn',
  20: 'zwanzig',
  30: 'dreißig',
  40: 'vierzig',
  50: 'fünfzig',
  60: 'sechzig',
  70: 'siebzig',
  80: 'achtzig',
  90: 'neunzig',
};

const ONES_DE: Record<number, string> = {
  1: 'ein',
  2: 'zwei',
  3: 'drei',
  4: 'vier',
  5: 'fünf',
  6: 'sechs',
  7: 'sieben',
  8: 'acht',
  9: 'neun',
};

function numberToWordsDE(num: number): string {
  const word = NUMBER_TO_WORDS_DE[num];
  if (word) {
    return word;
  }
  if (num < 100) {
    const tens = Math.floor(num / 10) * 10;
    const ones = num % 10;
    const onesWord = ONES_DE[ones];
    const tensWord = NUMBER_TO_WORDS_DE[tens];
    // German numbers are reversed: 21 = "einundzwanzig" (one-and-twenty)
    if (onesWord && tensWord) {
      return `${onesWord}und${tensWord}`;
    }
  }
  return num.toString();
}

/**
 * Format numbers in German text for TTS
 *
 * - Small numbers (0-99) → German words
 * - Years (1900-2099) → preserved as numbers
 * - Large numbers → preserved
 * - Decimals → "X Komma Y Z..." (individual digits after decimal)
 * - Removes dots/spaces from thousands separators
 */
export const formatNumbersDE: TextTransform = (
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

          // Remove German thousands separators (dots and spaces)
          processed = processed.replace(/(\d+)[.\s](\d{3})/g, '$1$2');

          // Format decimal numbers (German uses comma as decimal separator)
          processed = processed.replace(/\b(\d+),(\d+)\b/g, (match, whole, decimal) => {
            const wholeNum = parseInt(whole, 10);
            // Don't format years
            if (wholeNum >= 1900 && wholeNum <= 2099) {
              return match;
            }

            const wholePart = wholeNum <= 99 ? numberToWordsDE(wholeNum) : wholeNum.toString();
            const decimalPart = decimal.split('').join(' ');
            return `${wholePart} Komma ${decimalPart}`;
          });

          // Format whole numbers
          processed = processed.replace(/\b(\d+)\b/g, (match) => {
            const num = parseInt(match, 10);
            // Don't format years or large numbers
            if ((num >= 1900 && num <= 2099) || num > 99) {
              return match;
            }
            return numberToWordsDE(num);
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
 * Format Euro amounts for TTS in German
 *
 * Examples:
 * - "5€" → "fünf Euro"
 * - "12,50€" → "zwölf Euro und fünfzig Cent"
 * - "1€" → "ein Euro" (singular)
 */
export const formatEuroAmounts: TextTransform = (
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

          const processed = value.replace(/(\d+)(?:,(\d+))?\s*€/g, (match, euros, cents) => {
            const euroNum = parseInt(euros, 10);
            const euroWord = euroNum <= 99 ? numberToWordsDE(euroNum) : euroNum.toString();
            const euroUnit = 'Euro'; // Euro doesn't change in plural in German

            if (cents) {
              const centsNum = parseInt(cents, 10);
              const centsWord = centsNum <= 99 ? numberToWordsDE(centsNum) : centsNum.toString();
              const centsUnit = 'Cent'; // Cent doesn't change in plural
              return `${euroWord} ${euroUnit} und ${centsWord} ${centsUnit}`;
            }

            return `${euroWord} ${euroUnit}`;
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
 * Format percentages for TTS in German
 *
 * Example: "67%" → "67 Prozent"
 */
export const formatPercentagesDE: TextTransform = (
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

          const processed = value.replace(/(\d+(?:,\d+)?)%/g, '$1 Prozent');
          controller.enqueue(processed);
        }
      } catch (error) {
        controller.error(error);
      }
    },
  });
};

/**
 * Format distance measurements for TTS in German
 *
 * Examples:
 * - "5 km" → "5 Kilometer"
 * - "10 mi" → "10 Meilen"
 * - "3,5 m" → "3,5 Meter"
 */
export const formatDistancesDE: TextTransform = (
  text: ReadableStream<string>,
): ReadableStream<string> => {
  const unitMap: Record<string, string> = {
    km: 'Kilometer',
    mi: 'Meilen',
    m: 'Meter',
    ft: 'Fuß',
    yd: 'Yards',
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

          // Remove German thousands separators
          processed = processed.replace(/(\d+)[.\s](\d{3})/g, '$1$2');

          // Format distances
          for (const [abbrev, full] of Object.entries(unitMap)) {
            const pattern = new RegExp(`\\b(\\d+(?:,\\d+)?)\\s*${abbrev}\\b`, 'gi');
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
 * Format weight and volume units for TTS in German
 *
 * Examples:
 * - "10 kg" → "zehn Kilogramm"
 * - "2,5 lb" → "2,5 Pfund"
 * - "500 ml" → "500 Milliliter"
 */
export const formatUnitsDE: TextTransform = (
  text: ReadableStream<string>,
): ReadableStream<string> => {
  const unitMap: Record<string, string> = {
    lb: 'Pfund',
    lbs: 'Pfund',
    oz: 'Unzen',
    kg: 'Kilogramm',
    g: 'Gramm',
    mg: 'Milligramm',
    l: 'Liter',
    ml: 'Milliliter',
    gal: 'Gallonen',
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
              const word = number <= 99 ? numberToWordsDE(number) : num;
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
 * Format dates for TTS in German
 *
 * Example: "2024-12-25" → "Mittwoch, 25. Dezember 2024"
 */
export const formatDatesDE: TextTransform = (
  text: ReadableStream<string>,
): ReadableStream<string> => {
  const monthNames = [
    'Januar',
    'Februar',
    'März',
    'April',
    'Mai',
    'Juni',
    'Juli',
    'August',
    'September',
    'Oktober',
    'November',
    'Dezember',
  ];

  const dayNames = [
    'Sonntag',
    'Montag',
    'Dienstag',
    'Mittwoch',
    'Donnerstag',
    'Freitag',
    'Samstag',
  ];

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
                // German date format: "Mittwoch, 25. Dezember 2024"
                return `${dayName}, ${parseInt(day)}. ${monthName} ${year}`;
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
 * Registry of all German-specific transforms
 */
export const germanTransforms = new Map<string, TextTransform>([
  ['format_numbers_de', formatNumbersDE],
  ['format_euro_amounts', formatEuroAmounts],
  ['format_percentages_de', formatPercentagesDE],
  ['format_distances_de', formatDistancesDE],
  ['format_units_de', formatUnitsDE],
  ['format_dates_de', formatDatesDE],
]);
