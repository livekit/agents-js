// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, it } from 'vitest';
import { TTS } from './tts.js';

const hasMinimaxConfig = Boolean(process.env.MINIMAX_API_KEY);

if (hasMinimaxConfig) {
  describe('MiniMax TTS', () => {
    it('constructs without throwing', () => {
      new TTS();
    });
  });
} else {
  describe('MiniMax TTS', () => {
    it.skip('requires MINIMAX_API_KEY', () => {});
  });
}
