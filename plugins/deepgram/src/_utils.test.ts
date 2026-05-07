// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { appendQueryParams } from './_utils.js';

describe('appendQueryParams', () => {
  it('preserves non-ASCII keyterm and keywords values in the websocket URL', () => {
    const url = new URL('wss://api.deepgram.com/v1/listen');

    appendQueryParams(url, {
      keyterm: ['słucham', 'dzień dobry', 'znamię', 'dziękuję'],
      keywords: ['potwierdź:3', 'żółć:1.5'],
    });

    expect(url.searchParams.getAll('keyterm')).toEqual([
      'słucham',
      'dzień dobry',
      'znamię',
      'dziękuję',
    ]);
    expect(url.searchParams.getAll('keywords')).toEqual(['potwierdź:3', 'żółć:1.5']);
    expect(url.toString()).not.toContain('%25');
  });
});
