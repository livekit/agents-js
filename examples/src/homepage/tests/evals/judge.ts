// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { ChatContext, type LLM, tool } from '@livekit/agents';
import { z } from 'zod';

export type Judgment = {
  verdict: 'pass' | 'fail' | 'maybe';
  reasoning: string;
};

/** Evaluate a complete conversation against one criterion. */
export async function judgeConversation(
  llm: LLM,
  chatCtx: ChatContext,
  criteria: string,
): Promise<Judgment> {
  const submitVerdict = tool({
    name: 'submit_verdict',
    description: 'Submit the conversation evaluation verdict.',
    parameters: z.object({
      verdict: z.enum(['pass', 'fail', 'maybe']),
      reasoning: z.string(),
    }),
    execute: async (judgment: Judgment) => judgment,
  });
  const evaluation = new ChatContext();
  evaluation.addMessage({
    role: 'system',
    content:
      'You are an evaluator for conversational AI agents. Analyze the conversation against ' +
      "the given criteria, then call submit_verdict with 'pass', 'fail', or 'maybe' and brief reasoning.",
  });
  evaluation.addMessage({
    role: 'user',
    content:
      `Criteria: ${criteria}\n\nConversation:\n${JSON.stringify(
        chatCtx.toJSON({ excludeTimestamp: true }),
        null,
        2,
      )}` + '\n\nEvaluate if the conversation meets the criteria.',
  });

  let judgment: Judgment | undefined;
  const stream = llm.chat({
    chatCtx: evaluation,
    toolCtx: [submitVerdict],
    toolChoice: 'required',
    extraKwargs: { temperature: 0 },
  });
  for await (const chunk of stream) {
    const args = chunk.delta?.toolCalls?.[0]?.args;
    if (!args) continue;
    try {
      judgment = JSON.parse(args) as Judgment;
    } catch {
      // Tool arguments may arrive incrementally.
    }
  }
  if (!judgment) throw new Error('conversation judge did not return a verdict');
  return judgment;
}
