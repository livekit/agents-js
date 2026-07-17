// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expectTypeOf, it } from 'vitest';
import { Agent } from './agent.js';

describe('Agent model getters', () => {
  it('preserves undefined-based narrowing for existing callers', () => {
    const agent = new Agent({ instructions: 'test' });

    expectTypeOf(agent.stt).not.toEqualTypeOf<null>();
    expectTypeOf(agent.vad).not.toEqualTypeOf<null>();
    expectTypeOf(agent.llm).not.toEqualTypeOf<null>();
    expectTypeOf(agent.tts).not.toEqualTypeOf<null>();

    if (agent.stt !== undefined) {
      agent.stt.stream();
    }
    if (agent.vad !== undefined) {
      agent.vad.stream();
    }
    if (agent.llm !== undefined) {
      agent.llm.label();
    }
    if (agent.tts !== undefined) {
      agent.tts.stream();
    }
  });
});
