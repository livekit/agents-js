// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { ReadableStream } from 'node:stream/web';
// Import transform implementations (will be created next)
import { languageAgnosticTransforms } from './transforms_agnostic.js';
import { germanTransforms } from './transforms_de.js';
import { englishTransforms } from './transforms_en.js';

/**
 * Language codes supported by the transform system
 */
export type Language = 'en' | 'de' | string;

/**
 * Base type for all text transforms
 */
export type TextTransform = (text: ReadableStream<string>) => ReadableStream<string>;

/**
 * Built-in language-agnostic transform names
 */
export type LanguageAgnosticTransformName =
  | 'filter_markdown'
  | 'filter_emoji'
  | 'remove_angle_bracket_content'
  | 'replace_newlines_with_periods'
  | 'format_emails'
  | 'format_phone_numbers'
  | 'format_times';

/**
 * Built-in English-specific transform names
 */
export type EnglishTransformName =
  | 'format_numbers'
  | 'format_dollar_amounts'
  | 'format_percentages'
  | 'format_distances'
  | 'format_units'
  | 'format_dates'
  | 'format_acronyms';

/**
 * Built-in German-specific transform names
 */
export type GermanTransformName =
  | 'format_numbers_de'
  | 'format_euro_amounts'
  | 'format_percentages_de'
  | 'format_distances_de'
  | 'format_units_de'
  | 'format_dates_de';

/**
 * Union of all built-in transform names
 */
export type BuiltInTransformName =
  | LanguageAgnosticTransformName
  | EnglishTransformName
  | GermanTransformName;

/**
 * Text transform specification - can be a built-in name or a custom function
 */
export type TextTransformSpec = BuiltInTransformName | TextTransform;

/**
 * Default transforms applied to TTS text
 */
export const DEFAULT_TTS_TEXT_TRANSFORMS: BuiltInTransformName[] = [
  'filter_markdown',
  'filter_emoji',
];

/**
 * Get recommended TTS text transforms for a specific language
 *
 * This helper returns a curated set of transforms that work well for TTS
 * in the specified language, including both language-agnostic and
 * language-specific transforms.
 *
 * @param language - The language code (e.g., 'en', 'de')
 * @returns Array of recommended transform names
 *
 * @example
 * ```typescript
 * // Get transforms for English
 * const transforms = getRecommendedTTSTransforms('en');
 * // Returns: ['filter_markdown', 'filter_emoji', 'format_numbers', 'format_dollar_amounts', ...]
 *
 * // Get transforms for German
 * const transforms = getRecommendedTTSTransforms('de');
 * // Returns: ['filter_markdown', 'filter_emoji', 'format_numbers_de', 'format_euro_amounts', ...]
 * ```
 */
export function getRecommendedTTSTransforms(language: Language = 'en'): BuiltInTransformName[] {
  const baseTransforms: BuiltInTransformName[] = ['filter_markdown', 'filter_emoji'];

  const languageSpecificRecommendations: Record<string, BuiltInTransformName[]> = {
    en: [
      'format_numbers',
      'format_dollar_amounts',
      'format_percentages',
      'format_distances',
      'format_units',
      'format_dates',
      'format_acronyms',
    ],
    de: [
      'format_numbers_de',
      'format_euro_amounts',
      'format_percentages_de',
      'format_distances_de',
      'format_units_de',
      'format_dates_de',
    ],
  };

  const langSpecific = languageSpecificRecommendations[language] || [];
  return [...baseTransforms, ...langSpecific];
}

/**
 * Apply a sequence of text transforms to a text stream
 *
 * Transforms can be specified either as built-in transform names (strings)
 * or as custom transform functions. Built-in transforms are looked up across
 * all registered transforms (language-agnostic and all language-specific).
 *
 * @param text - Input text stream
 * @param transforms - Array of transform names or custom transform functions
 * @returns Transformed text stream
 *
 * @example
 * ```typescript
 * // Use built-in transforms (names)
 * const text = new ReadableStream(...);
 * const transformed = await applyTextTransforms(text, [
 *   'filter_markdown',
 *   'format_numbers',  // English
 *   'format_euro_amounts',  // German
 * ]);
 *
 * // Mix built-in and custom transforms
 * const customTransform: TextTransform = (stream) => ...;
 * const transformed = await applyTextTransforms(text, [
 *   'filter_markdown',
 *   customTransform,
 * ]);
 * ```
 */
export async function applyTextTransforms(
  text: ReadableStream<string>,
  transforms: readonly TextTransformSpec[],
): Promise<ReadableStream<string>> {
  let result = text;

  for (const transform of transforms) {
    if (typeof transform === 'function') {
      // Custom transform function
      result = transform(result);
    } else {
      // Built-in transform name - search across all registries
      const transformFn = getBuiltInTransform(transform);
      if (!transformFn) {
        throw new Error(
          `Invalid transform: ${transform}. ` +
            `Available transforms: ${Array.from(getAllAvailableTransforms()).join(', ')}`,
        );
      }
      result = transformFn(result);
    }
  }

  return result;
}

/**
 * Get a built-in transform function by name
 *
 * Searches across all registered transforms:
 * 1. First checks language-agnostic transforms
 * 2. Then searches through all language-specific transform registries
 *
 * @param name - The built-in transform name
 * @returns The transform function, or null if not found
 */
function getBuiltInTransform(name: BuiltInTransformName): TextTransform | null {
  // Check language-agnostic transforms first
  const agnostic = languageAgnosticTransforms.get(name as LanguageAgnosticTransformName);
  if (agnostic) {
    return agnostic;
  }

  // Check all language-specific transform registries
  for (const langTransforms of languageSpecificTransforms.values()) {
    const transform = langTransforms.get(name);
    if (transform) {
      return transform;
    }
  }

  return null;
}

/**
 * Get all available transform names across all languages
 *
 * Returns a set containing all registered transform names, including
 * language-agnostic and all language-specific transforms.
 *
 * @returns Set of all available transform names
 */
export function getAllAvailableTransforms(): Set<string> {
  const available = new Set<string>();

  // Add language-agnostic transforms
  for (const name of languageAgnosticTransforms.keys()) {
    available.add(name);
  }

  // Add all language-specific transforms
  for (const langTransforms of languageSpecificTransforms.values()) {
    for (const name of langTransforms.keys()) {
      available.add(name);
    }
  }

  return available;
}

/**
 * Get all available transform names for a given language
 *
 * Returns a set containing language-agnostic transforms plus transforms
 * specific to the requested language.
 *
 * @param language - The language code (e.g., 'en', 'de')
 * @returns Set of available transform names for the language
 */
export function getAvailableTransforms(language: Language = 'en'): Set<string> {
  const available = new Set<string>();

  // Add language-agnostic transforms
  for (const name of languageAgnosticTransforms.keys()) {
    available.add(name);
  }

  // Add language-specific transforms
  const langTransforms = languageSpecificTransforms.get(language);
  if (langTransforms) {
    for (const name of langTransforms.keys()) {
      available.add(name);
    }
  }

  return available;
}

/**
 * Helper to create a transform function with buffering for sentence boundaries
 *
 * This is useful for transforms that need to see complete sentences or tokens
 * before processing them. It buffers input until a sentence boundary is reached,
 * then applies the regex pattern with optional preprocessing.
 *
 * @param pattern - Regex pattern to match
 * @param replacement - Replacement string or function
 * @param options - Additional options for buffering and preprocessing
 */
export function createBufferedRegexTransform(
  pattern: RegExp,
  replacement: string | ((match: string, ...args: any[]) => string),
  options: {
    /** Buffer until these characters are encountered (sentence boundaries) */
    sentenceBoundaries?: string[];
    /** Preprocessing function applied before regex matching */
    preprocess?: (text: string) => string;
    /** Minimum buffer size before attempting to process */
    minBufferSize?: number;
  } = {},
): TextTransform {
  const { sentenceBoundaries = ['.', '!', '?', '\n'], preprocess, minBufferSize = 0 } = options;

  return (text: ReadableStream<string>): ReadableStream<string> => {
    let buffer = '';

    return new ReadableStream({
      async start(controller) {
        try {
          const reader = text.getReader();

          while (true) {
            const { done, value } = await reader.read();

            if (done) {
              // Process remaining buffer
              if (buffer.length > 0) {
                let processed = preprocess ? preprocess(buffer) : buffer;
                processed =
                  typeof replacement === 'function'
                    ? processed.replace(pattern, replacement as any)
                    : processed.replace(pattern, replacement);
                controller.enqueue(processed);
              }
              controller.close();
              break;
            }

            buffer += value;

            // Check if we have a sentence boundary
            let lastBoundaryPos = -1;
            for (const boundary of sentenceBoundaries) {
              const pos = buffer.lastIndexOf(boundary);
              lastBoundaryPos = Math.max(lastBoundaryPos, pos);
            }

            // Process if we found a boundary and have enough buffer
            if (lastBoundaryPos > 0 && buffer.length >= minBufferSize) {
              const processable = buffer.substring(0, lastBoundaryPos + 1);
              buffer = buffer.substring(lastBoundaryPos + 1);

              let processed = preprocess ? preprocess(processable) : processable;
              processed =
                typeof replacement === 'function'
                  ? processed.replace(pattern, replacement as any)
                  : processed.replace(pattern, replacement);
              controller.enqueue(processed);
            }
          }
        } catch (error) {
          controller.error(error);
        }
      },
    });
  };
}

// Build the language-specific transforms registry
const languageSpecificTransforms = new Map<Language, Map<string, TextTransform>>();
languageSpecificTransforms.set('en', englishTransforms);
languageSpecificTransforms.set('de', germanTransforms);
