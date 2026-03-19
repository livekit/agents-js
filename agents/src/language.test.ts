// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import {
  areLanguagesEquivalent,
  getBaseLanguage,
  getIsoLanguage,
  getLanguageRegion,
  normalizeLanguage,
  toLanguageName,
} from './language.js';

describe('normalizeLanguage', () => {
  it('normalizes language names', () => {
    expect(normalizeLanguage('english')).toBe('en');
  });

  it('normalizes iso 639-3 codes', () => {
    expect(normalizeLanguage('eng')).toBe('en');
  });

  it('normalizes bcp-47 casing and separators', () => {
    expect(normalizeLanguage('en_us')).toBe('en-US');
    expect(normalizeLanguage('zh_hans_cn')).toBe('zh-Hans-CN');
  });

  it('preserves iso 639-3 in compound tags', () => {
    expect(normalizeLanguage('cmn_hans_cn')).toBe('cmn-Hans-CN');
  });

  it('passes unknown codes through in lowercase', () => {
    expect(normalizeLanguage('MULTI')).toBe('multi');
  });

  it('preserves empty string sentinel', () => {
    expect(normalizeLanguage('')).toBe('');
  });
});

describe('language helpers', () => {
  it('extracts base language', () => {
    expect(getBaseLanguage('cmn-Hans-CN')).toBe('zh');
  });

  it('builds iso language tag', () => {
    expect(getIsoLanguage('cmn-Hans-CN')).toBe('zh-CN');
  });

  it('extracts region', () => {
    expect(getLanguageRegion('en-US')).toBe('US');
  });

  it('maps normalized code back to language name', () => {
    expect(toLanguageName('eng')).toBe('english');
  });

  it('compares equivalent representations', () => {
    expect(areLanguagesEquivalent('english', 'en')).toBe(true);
    expect(areLanguagesEquivalent('en_us', 'en-US')).toBe(true);
  });
});
