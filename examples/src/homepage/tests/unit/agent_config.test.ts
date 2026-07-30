// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { AgentConfig, CONFIG } from '../../agent.js';

describe('agent config', () => {
  it('is the single source of runtime identity', () => {
    expect(new AgentConfig()).toEqual(CONFIG);
    expect(CONFIG.name).toBe('homepage_agent_v3');
    expect(CONFIG.ttsVoice).toBe('Nate');
    expect(Object.isFrozen(CONFIG)).toBe(true);
    expect(() => Object.assign(CONFIG, { ttsVoice: 'Alex' })).toThrow(TypeError);
  });
});
