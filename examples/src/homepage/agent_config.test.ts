// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { CONFIG, createAgentConfig } from './agent.js';

describe('homepage agent config', () => {
  it('is the single source of runtime identity', () => {
    expect(createAgentConfig()).toEqual(CONFIG);
    expect(CONFIG.name).toBe('homepage_agent_v3');
    expect(CONFIG.ttsVoice).toBe('Nate');

    expect(() => {
      (CONFIG as { ttsVoice: string }).ttsVoice = 'Alex';
    }).toThrow(TypeError);
  });
});
