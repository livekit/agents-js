// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { prompt } from '../../prompts/index.js';

describe('prompts', () => {
  it.each(['agents_sdks', 'greeting', 'user_away'])('loads the named prompt %s', (name) => {
    expect(prompt(name).trim()).not.toBe('');
  });

  it('throws for a missing prompt', () => {
    expect(() => prompt('no_such_prompt')).toThrow();
  });
});
