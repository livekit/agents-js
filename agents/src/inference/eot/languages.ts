// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
/**
 * Per-language `unlikely` thresholds for the audio EOT detector.
 *
 * Calibrated separately per checkpoint — do NOT unify CLOUD and LOCAL tables.
 */

export type TurnDetectorModel = 'turn-detector' | 'turn-detector-mini';

export const CLOUD_LANGUAGES: Readonly<Record<string, number>> = {
  ar: 0.355,
  de: 0.495,
  en: 0.56,
  es: 0.59,
  fr: 0.575,
  hi: 0.575,
  id: 0.47,
  it: 0.64,
  ja: 0.37,
  ko: 0.695,
  nl: 0.75,
  pt: 0.665,
  tr: 0.65,
  zh: 0.59,
};

export const LOCAL_LANGUAGES: Readonly<Record<string, number>> = {
  ar: 0.35,
  de: 0.245,
  en: 0.36,
  es: 0.35,
  fr: 0.285,
  hi: 0.305,
  id: 0.345,
  it: 0.23,
  ja: 0.295,
  ko: 0.4,
  nl: 0.2,
  pt: 0.32,
  tr: 0.255,
  zh: 0.355,
};

const BASE: Record<TurnDetectorModel, Readonly<Record<string, number>>> = {
  'turn-detector': CLOUD_LANGUAGES,
  'turn-detector-mini': LOCAL_LANGUAGES,
};

/**
 * BCP-47 language tag (or human-readable name) → ISO 639-1 two-letter code.
 *
 * Minimal port of Python's `LanguageCode` — covers the languages present in
 * the threshold tables. Unknown inputs are returned lowercased and unchanged
 * (callers should pass `en`, `en-US`, `English`, etc.).
 */
function normalizeLanguage(input: string): string {
  const lower = input.toLowerCase().trim();
  if (lower.length === 2) return lower;
  const dashIdx = lower.indexOf('-');
  if (dashIdx === 2) return lower.slice(0, 2);
  // long-name aliases for languages in our tables
  const aliases: Record<string, string> = {
    arabic: 'ar',
    german: 'de',
    english: 'en',
    spanish: 'es',
    french: 'fr',
    hindi: 'hi',
    indonesian: 'id',
    italian: 'it',
    japanese: 'ja',
    korean: 'ko',
    dutch: 'nl',
    portuguese: 'pt',
    turkish: 'tr',
    chinese: 'zh',
    mandarin: 'zh',
  };
  return aliases[lower] ?? lower;
}

/**
 * Resolve user override + per-model defaults into a complete per-language
 * threshold map.
 *
 * - `undefined`: returns a copy of the bare model table.
 * - `number`: fills every language with the same value.
 * - object: overrides per-language (keys are normalized so `English` /
 *   `en` / `en-US` all collapse to `en`); unmapped languages keep the default.
 */
export function materializeThresholds(
  userValue: number | Record<string, number> | undefined,
  model: TurnDetectorModel,
): Record<string, number> {
  const base = BASE[model];
  if (userValue === undefined) {
    return { ...base };
  }
  if (typeof userValue === 'number') {
    const out: Record<string, number> = {};
    for (const lang of Object.keys(base)) {
      out[lang] = userValue;
    }
    return out;
  }
  const norm: Record<string, number> = {};
  for (const [k, v] of Object.entries(userValue)) {
    norm[normalizeLanguage(k)] = Number(v);
  }
  const out: Record<string, number> = {};
  for (const [lang, defaultValue] of Object.entries(base)) {
    out[lang] = norm[lang] ?? defaultValue;
  }
  return out;
}

/**
 * Preserve the user's cloud-vs-default ratio when promoting local:
 * `local = LOCAL[lang] * (cloud_t / CLOUD[lang])` per language.
 */
export function rescaleForLocalFallback(
  cloudThresholds: Record<string, number>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [lang, cloudT] of Object.entries(cloudThresholds)) {
    const cloudDefault = CLOUD_LANGUAGES[lang];
    const localDefault = LOCAL_LANGUAGES[lang];
    if (cloudDefault !== undefined && localDefault !== undefined && cloudDefault !== 0) {
      out[lang] = localDefault * (cloudT / cloudDefault);
    }
  }
  return out;
}
