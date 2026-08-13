// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
import type { ChatContext } from '../llm/chat_context.js';
import { tool } from '../llm/tool_context.js';
import { Future } from '../utils.js';
import { Agent } from './agent.js';
import { AgentSession } from './agent_session.js';
import { RUNNING_TOOL_PLACEHOLDER } from './generation.js';
import { FakeLLM } from './testing/fake_llm.js';

type PostToolContextObservation = {
  canonicalHasToolOutput: boolean;
  preToolSnapshotIsEquivalent: boolean;
};

class ContextInspectingLLM extends FakeLLM {
  agent?: Agent;
  preToolContext?: ChatContext;
  readonly mhmmContexts: ChatContext[] = [];
  readonly postToolInference = new Future<PostToolContextObservation>();

  override chat(options: Parameters<FakeLLM['chat']>[0]) {
    if (
      options.chatCtx.items.some(
        (item) => item.type === 'message' && item.role === 'user' && item.textContent === 'Mhmm',
      )
    ) {
      this.mhmmContexts.push(options.chatCtx.copy());
    }

    const toolOutput = options.chatCtx.items.find(
      (item) => item.type === 'function_call_output' && item.output !== RUNNING_TOOL_PLACEHOLDER,
    );
    if (toolOutput && !this.postToolInference.done) {
      if (!this.agent || !this.preToolContext) {
        throw new Error('tool context snapshots were not initialized');
      }
      const canonicalContext = this.agent.chatCtx;
      this.postToolInference.resolve({
        canonicalHasToolOutput: canonicalContext.items.some(
          (item) => item.type === 'function_call_output' && item.callId === toolOutput.callId,
        ),
        preToolSnapshotIsEquivalent: this.preToolContext.isEquivalent(canonicalContext),
      });
    }
    return super.chat(options);
  }
}

describe('AgentActivity tool output commit ordering', () => {
  it('invalidates a stale preemptive generation when late EOU interrupts the post-tool reply', async () => {
    const llm = new ContextInspectingLLM([
      {
        input: 'find loads',
        toolCalls: [{ name: 'lookup_loads', args: {} }],
      },
      { input: 'Mhmm', content: 'Let me check.' },
      { input: '"no loads"', content: 'No loads were found.', duration: 1_000 },
    ]);
    const toolStarted = new Future<void>();
    const releaseTool = new Future<void>();
    const agent: Agent = new Agent({
      instructions: 'test',
      tools: {
        lookup_loads: tool({
          description: 'Look up available loads',
          execute: async () => {
            llm.preToolContext = agent.chatCtx.copy();
            toolStarted.resolve();
            await releaseTool.await;
            return 'no loads';
          },
        }),
      },
    });
    llm.agent = agent;

    const session = new AgentSession({ llm });
    session.output.setAudioEnabled(false);
    session.output.setTranscriptionEnabled(false);

    await session.start({ agent });
    try {
      const speech = session.generateReply({ userInput: 'find loads' });
      await toolStarted.await;

      const activity = session._activity as unknown as {
        _currentSpeech?: unknown;
        onPreemptiveGeneration: (info: {
          newTranscript: string;
          transcriptConfidence: number;
          startedSpeakingAt?: number;
        }) => void;
        userTurnCompleted: (info: {
          newTranscript: string;
          transcriptConfidence: number;
          skipReply: boolean;
        }) => Promise<void>;
      };
      await vi.waitFor(() => expect(activity._currentSpeech).toBeUndefined());
      activity.onPreemptiveGeneration({
        newTranscript: 'Mhmm',
        transcriptConfidence: 0.9,
      });
      await vi.waitFor(() => expect(llm.mhmmContexts).toHaveLength(1));

      releaseTool.resolve();
      const observation = await llm.postToolInference.await;

      expect(llm.preToolContext?.items.some((item) => item.type === 'function_call')).toBe(true);
      expect(observation.canonicalHasToolOutput).toBe(true);
      expect(observation.preToolSnapshotIsEquivalent).toBe(false);

      await vi.waitFor(() => expect(activity._currentSpeech).toBeDefined());
      await activity.userTurnCompleted({
        newTranscript: 'Mhmm',
        transcriptConfidence: 0.9,
        skipReply: false,
      });
      await vi.waitFor(() => expect(llm.mhmmContexts).toHaveLength(2));

      const staleOutput = llm.mhmmContexts[0]!.items.find(
        (item) => item.type === 'function_call_output',
      );
      const regeneratedOutput = llm.mhmmContexts[1]!.items.find(
        (item) => item.type === 'function_call_output',
      );
      expect(staleOutput?.output).toBe(RUNNING_TOOL_PLACEHOLDER);
      expect(regeneratedOutput?.output).toBe('"no loads"');

      await speech.waitForPlayout();

      const toolCall = agent.chatCtx.items.find((item) => item.type === 'function_call');
      const toolOutputs = agent.chatCtx.items.filter(
        (item) => item.type === 'function_call_output' && item.callId === toolCall?.callId,
      );
      expect(toolCall).toBeDefined();
      expect(toolOutputs).toHaveLength(1);
      expect(agent.chatCtx.items.indexOf(toolOutputs[0]!)).toBeGreaterThan(
        agent.chatCtx.items.indexOf(toolCall!),
      );
    } finally {
      await session.close();
    }
  });
});
