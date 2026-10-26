// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { Agent } from './agent.js';
import { AgentSession } from './agent_session.js';
import { FakeLLM, type FakeLLMResponse } from './testing/fake_llm.js';

class TrackingLLM extends FakeLLM {
  prewarmCalls = 0;

  constructor(
    responses: FakeLLMResponse[] = [],
    private readonly events: string[] = [],
  ) {
    super(responses);
  }

  override chat(options: Parameters<FakeLLM['chat']>[0]) {
    this.events.push('chat');
    return super.chat(options);
  }

  protected override async _prewarmImpl(_signal: AbortSignal): Promise<void> {
    this.prewarmCalls += 1;
    this.events.push('prewarm');
  }
}

describe('AgentActivity LLM prewarm', () => {
  it('prewarms an agent-level LLM exactly once before its first inference', async () => {
    const sessionLLM = new TrackingLLM();
    const agentEvents: string[] = [];
    const agentLLM = new TrackingLLM([{ input: 'hello', content: 'hi' }], agentEvents);
    const session = new AgentSession({
      llm: sessionLLM,
      vad: null,
      turnHandling: { turnDetection: null },
    });

    expect(sessionLLM.prewarmCalls).toBe(1);
    expect(agentLLM.prewarmCalls).toBe(0);

    try {
      await session.start({
        agent: new Agent({ instructions: '', llm: agentLLM }),
      });

      expect(agentLLM.prewarmCalls).toBe(1);
      expect(sessionLLM.prewarmCalls).toBe(1);

      await session.run({ userInput: 'hello' }).wait();

      expect(agentEvents).toEqual(['prewarm', 'chat']);
      expect(agentLLM.prewarmCalls).toBe(1);
    } finally {
      await session.close();
    }
  });
});
