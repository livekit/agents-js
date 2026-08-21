// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
// Type-only assertions. `tsconfig.typecheck.json` compiles just `*.type.test.ts`, so this
// is the only place `expectTypeOf` is actually enforced — the runtime suites exclude it.
import { describe, expectTypeOf, it } from 'vitest';
import { Agent, type AgentOptions, type AgentUpdateOptions } from './agent.js';

describe('Agent model getters', () => {
  it('preserves undefined-based narrowing for existing callers', () => {
    const agent = new Agent({ instructions: 'test' });

    expectTypeOf(agent.stt).not.toEqualTypeOf<null>();
    expectTypeOf(agent.vad).not.toEqualTypeOf<null>();
    expectTypeOf(agent.llm).not.toEqualTypeOf<null>();
    expectTypeOf(agent.tts).not.toEqualTypeOf<null>();

    if (agent.stt !== undefined) agent.stt.stream();
    if (agent.vad !== undefined) agent.vad.stream();
    if (agent.llm !== undefined) agent.llm.label();
    if (agent.tts !== undefined) agent.tts.stream();
  });
});

describe('AgentUpdateOptions', () => {
  // It restates these `AgentOptions` fields so it can document the update-specific
  // semantics; this catches the two drifting apart.
  it('stays in lockstep with the AgentOptions fields it overrides', () => {
    expectTypeOf<AgentUpdateOptions>().toEqualTypeOf<
      Pick<AgentOptions<never>, 'stt' | 'vad' | 'llm' | 'tts' | 'expressive'>
    >();
  });
});
