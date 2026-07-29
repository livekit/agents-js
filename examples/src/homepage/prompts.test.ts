// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { prompt } from './prompts/index.js';

describe('homepage prompts', () => {
  it.each(['agents_sdks', 'greeting', 'user_away'])('loads prompt %s', (name) => {
    expect(prompt(name).trim()).toBeTruthy();
  });

  it('throws for missing prompts', () => {
    expect(() => prompt('no_such_prompt')).toThrow('no prompt named');
  });
});
