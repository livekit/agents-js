// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

export const KNOWN_LANGUAGE_CODES = [
  'af',
  'am',
  'ar',
  'as',
  'az',
  'be',
  'bg',
  'bn',
  'bs',
  'ca',
  'cs',
  'cy',
  'da',
  'de',
  'el',
  'en',
  'es',
  'et',
  'eu',
  'fa',
  'ff',
  'fi',
  'fr',
  'ga',
  'gl',
  'gu',
  'ha',
  'he',
  'hi',
  'hr',
  'hu',
  'hy',
  'id',
  'ig',
  'is',
  'it',
  'ja',
  'jv',
  'ka',
  'kk',
  'km',
  'kn',
  'ko',
  'ku',
  'ky',
  'lb',
  'lg',
  'ln',
  'lo',
  'lt',
  'lv',
  'mi',
  'mk',
  'ml',
  'mn',
  'mr',
  'ms',
  'mt',
  'my',
  'ne',
  'nl',
  'no',
  'ny',
  'oc',
  'or',
  'pa',
  'pl',
  'ps',
  'pt',
  'ro',
  'ru',
  'sd',
  'sk',
  'sl',
  'sn',
  'so',
  'sq',
  'sr',
  'sv',
  'sw',
  'ta',
  'te',
  'tg',
  'th',
  'tl',
  'tr',
  'uk',
  'ur',
  'uz',
  'vi',
  'wo',
  'xh',
  'yo',
  'zh',
  'zu',
] as const;

export type KnownLanguageCode = (typeof KNOWN_LANGUAGE_CODES)[number];

declare const languageCodeBrand: unique symbol;

export type LanguageCode = string & { readonly [languageCodeBrand]: 'LanguageCode' };

export function asLanguageCode(language: string): LanguageCode {
  return language as LanguageCode;
}

const ISO_639_3_TO_1: Record<string, string | undefined> = {
  afr: 'af',
  amh: 'am',
  ara: 'ar',
  hye: 'hy',
  asm: 'as',
  ast: undefined,
  aze: 'az',
  bel: 'be',
  ben: 'bn',
  bos: 'bs',
  bul: 'bg',
  mya: 'my',
  yue: undefined,
  cat: 'ca',
  ceb: undefined,
  cmn: 'zh',
  nya: 'ny',
  hrv: 'hr',
  ces: 'cs',
  dan: 'da',
  nld: 'nl',
  eng: 'en',
  est: 'et',
  fil: undefined,
  fin: 'fi',
  fra: 'fr',
  ful: 'ff',
  glg: 'gl',
  lug: 'lg',
  kat: 'ka',
  deu: 'de',
  ell: 'el',
  guj: 'gu',
  hau: 'ha',
  heb: 'he',
  hin: 'hi',
  hun: 'hu',
  isl: 'is',
  ibo: 'ig',
  ind: 'id',
  gle: 'ga',
  ita: 'it',
  jpn: 'ja',
  jav: 'jv',
  kea: undefined,
  kan: 'kn',
  kaz: 'kk',
  khm: 'km',
  kor: 'ko',
  kur: 'ku',
  kir: 'ky',
  lao: 'lo',
  lav: 'lv',
  lin: 'ln',
  lit: 'lt',
  luo: undefined,
  ltz: 'lb',
  mkd: 'mk',
  msa: 'ms',
  mal: 'ml',
  mlt: 'mt',
  zho: 'zh',
  mri: 'mi',
  mar: 'mr',
  mon: 'mn',
  nep: 'ne',
  nso: undefined,
  nor: 'no',
  oci: 'oc',
  ori: 'or',
  pus: 'ps',
  fas: 'fa',
  pol: 'pl',
  por: 'pt',
  pan: 'pa',
  ron: 'ro',
  rus: 'ru',
  srp: 'sr',
  sna: 'sn',
  snd: 'sd',
  slk: 'sk',
  slv: 'sl',
  som: 'so',
  spa: 'es',
  swa: 'sw',
  swe: 'sv',
  tam: 'ta',
  tgk: 'tg',
  tel: 'te',
  tha: 'th',
  tur: 'tr',
  ukr: 'uk',
  umb: undefined,
  urd: 'ur',
  uzb: 'uz',
  vie: 'vi',
  cym: 'cy',
  wol: 'wo',
  xho: 'xh',
  zul: 'zu',
};

const LANGUAGE_NAMES_TO_CODE: Record<string, string> = {
  afrikaans: 'af',
  albanian: 'sq',
  amharic: 'am',
  arabic: 'ar',
  armenian: 'hy',
  azerbaijani: 'az',
  basque: 'eu',
  belarusian: 'be',
  bengali: 'bn',
  bosnian: 'bs',
  bulgarian: 'bg',
  burmese: 'my',
  catalan: 'ca',
  chinese: 'zh',
  croatian: 'hr',
  czech: 'cs',
  danish: 'da',
  dutch: 'nl',
  english: 'en',
  estonian: 'et',
  finnish: 'fi',
  french: 'fr',
  galician: 'gl',
  georgian: 'ka',
  german: 'de',
  greek: 'el',
  gujarati: 'gu',
  hausa: 'ha',
  hebrew: 'he',
  hindi: 'hi',
  hungarian: 'hu',
  icelandic: 'is',
  indonesian: 'id',
  irish: 'ga',
  italian: 'it',
  japanese: 'ja',
  javanese: 'jv',
  kannada: 'kn',
  kazakh: 'kk',
  khmer: 'km',
  korean: 'ko',
  kurdish: 'ku',
  kyrgyz: 'ky',
  lao: 'lo',
  latvian: 'lv',
  lingala: 'ln',
  lithuanian: 'lt',
  luxembourgish: 'lb',
  macedonian: 'mk',
  malay: 'ms',
  malayalam: 'ml',
  maltese: 'mt',
  maori: 'mi',
  marathi: 'mr',
  mongolian: 'mn',
  nepali: 'ne',
  norwegian: 'no',
  occitan: 'oc',
  oriya: 'or',
  pashto: 'ps',
  persian: 'fa',
  polish: 'pl',
  portuguese: 'pt',
  punjabi: 'pa',
  romanian: 'ro',
  russian: 'ru',
  serbian: 'sr',
  shona: 'sn',
  sindhi: 'sd',
  slovak: 'sk',
  slovene: 'sl',
  slovenian: 'sl',
  somali: 'so',
  spanish: 'es',
  swahili: 'sw',
  swedish: 'sv',
  tagalog: 'tl',
  tamil: 'ta',
  tajik: 'tg',
  telugu: 'te',
  thai: 'th',
  turkish: 'tr',
  ukrainian: 'uk',
  urdu: 'ur',
  uzbek: 'uz',
  vietnamese: 'vi',
  welsh: 'cy',
  wolof: 'wo',
  xhosa: 'xh',
  yoruba: 'yo',
  zulu: 'zu',
};

const CODE_TO_LANGUAGE_NAME: Record<string, string> = Object.fromEntries(
  Object.entries(LANGUAGE_NAMES_TO_CODE).map(([name, code]) => [code, name]),
);

CODE_TO_LANGUAGE_NAME.sl = 'slovene';

export function normalizeLanguage(language: string): LanguageCode {
  const lowered = language.trim().toLowerCase();
  if (lowered === '') {
    return asLanguageCode('');
  }

  if (lowered in LANGUAGE_NAMES_TO_CODE) {
    return asLanguageCode(LANGUAGE_NAMES_TO_CODE[lowered]!);
  }

  if (lowered in ISO_639_3_TO_1) {
    return asLanguageCode(ISO_639_3_TO_1[lowered] ?? lowered);
  }

  const parts = lowered.replaceAll('_', '-').split('-');
  if (parts.length >= 2) {
    const [base, ...rest] = parts;
    return asLanguageCode(
      [
        base,
        ...rest.map((part) => {
          if (part.length === 4) {
            return part.charAt(0).toUpperCase() + part.slice(1);
          }
          return part.toUpperCase();
        }),
      ].join('-'),
    );
  }

  return asLanguageCode(lowered);
}

export function getBaseLanguage(language: string): string {
  const normalized = normalizeLanguage(language);
  const [base = ''] = normalized.split('-');
  return ISO_639_3_TO_1[base] ?? base;
}

export function getIsoLanguage(language: string): string {
  const normalized = normalizeLanguage(language);
  const region = getLanguageRegion(normalized);
  const baseLanguage = getBaseLanguage(normalized);
  return region ? `${baseLanguage}-${region}` : baseLanguage;
}

export function getLanguageRegion(language: string): string | undefined {
  const normalized = normalizeLanguage(language);
  const [, ...parts] = normalized.split('-');
  return parts.find((part) => part.length === 2);
}

export function toLanguageName(language: string): string | undefined {
  return CODE_TO_LANGUAGE_NAME[getBaseLanguage(language)];
}

export function areLanguagesEquivalent(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  if (left == null || right == null) {
    return left === right;
  }
  return normalizeLanguage(left) === normalizeLanguage(right);
}
