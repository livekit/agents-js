// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AgentSession, ChatContext, inference } from '@livekit/agents';
import { afterEach, describe, expect, it } from 'vitest';
import { Assistant } from '../../agent.js';
import { judgeConversation } from './judge.js';

const sessions: AgentSession[] = [];

function judgeLLM(): inference.LLM {
  return new inference.LLM({ model: 'openai/gpt-4.1-mini' });
}

async function startPrimed(): Promise<AgentSession> {
  const session = new AgentSession();
  sessions.push(session);
  const agent = new Assistant();
  await session.start({ agent });
  const chatCtx = new ChatContext();
  chatCtx.addMessage({
    role: 'assistant',
    content: "Hi! I'm your LiveKit assistant. What would you like to know about LiveKit?",
  });
  await agent.updateChatCtx(chatCtx);
  return session;
}

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()));
});

const ROUTING_CASES = [
  ['phone-buy', 'Can I buy a phone number directly from LiveKit?', 'livekit-phone-numbers'],
  [
    'phone-dispatch',
    "How do inbound phone calls get routed to my agent's room?",
    'livekit-phone-numbers',
  ],
  [
    'deploy-regions',
    'What regions can I deploy my agent to on LiveKit Cloud?',
    'agents-on-livekit-cloud',
  ],
  [
    'deploy-secrets',
    'What secrets get injected into my agent container at runtime?',
    'agents-on-livekit-cloud',
  ],
  [
    'inference-llms',
    'Which LLM providers can I use through LiveKit Inference?',
    'livekit-inference',
  ],
  [
    'observability',
    'How do I see transcripts and session traces for my agent?',
    'agent-observability',
  ],
  [
    'agent-builder',
    'Can I build a voice agent in my browser without writing code?',
    'agent-builder',
  ],
  [
    'platform-compliance',
    'What security and compliance certifications does LiveKit Cloud have?',
    'platform',
  ],
] as const;

const ACCURACY_CASES = [
  [
    'inference-self-host',
    'Can I use LiveKit Inference if I self-host LiveKit?',
    'States that LiveKit Inference is a LiveKit Cloud feature only and is not available for ' +
      'self-hosted LiveKit; self-hosting requires model plugins with your own provider API keys.',
  ],
  [
    'phone-outbound',
    'Does LiveKit Phone Numbers support outbound calling?',
    'Indicates LiveKit Phone Numbers currently supports inbound calling only and that outbound ' +
      'calling is not yet available (coming soon), optionally noting outbound requires a ' +
      'third-party SIP provider.',
  ],
  [
    'phone-country',
    'Which countries can I get a LiveKit phone number in?',
    'States that LiveKit phone numbers are available in the United States only, both local and toll-free.',
  ],
  [
    'observability-retention',
    'How long is my agent observability data retained?',
    'States that observability data is retained for about 30 days and that data older than 30 ' +
      'days is automatically deleted. Mentioning that data is stored in the United States is optional.',
  ],
  [
    'observability-self-host',
    'Does agent observability work with a fully self-hosted LiveKit deployment?',
    'Indicates agent observability does not work with entirely self-hosted deployments and ' +
      'requires LiveKit Cloud. Nuance about self-hosted agents using Cloud media servers is optional.',
  ],
  [
    'free-plan-minutes',
    'How many agent session minutes does the free Build plan include?',
    'States the free Build plan includes 1000 agent session minutes.',
  ],
  [
    'builder-export',
    'Can I export an agent I built in Agent Builder to code?',
    'Confirms that an agent built in Agent Builder can be exported or downloaded as a complete ' +
      'Python project to keep iterating with the Agents SDK.',
  ],
  [
    'platform-hipaa',
    'Is LiveKit Cloud HIPAA compliant?',
    'Confirms LiveKit Cloud is HIPAA compliant, optionally mentioning SOC 2 Type II, GDPR, or CCPA.',
  ],
] as const;

const HALLUCINATION_CASES = [
  [
    'no-phone-price',
    'Exactly how many dollars per month does a LiveKit phone number cost?',
    `The response does NOT state a specific dollar amount for the monthly phone number fee.
Acceptable responses say there is a small fixed monthly fee, direct the user to the LiveKit
pricing page, or say the exact figure isn't known. It fails only if it fabricates a specific price.`,
  ],
  [
    'no-token-price',
    'What is the exact price per million tokens for GPT-5 on LiveKit Inference?',
    `The response does NOT invent a specific per-token or per-million-token price. Acceptable
responses say Inference pricing is usage-based and point to the pricing page, or say the exact
number isn't known. It fails only if it states a specific fabricated dollar price.`,
  ],
  [
    'no-scale-price',
    'How much does the Scale plan cost per month in dollars?',
    `The response does NOT state a specific monthly dollar price for the Scale plan. Acceptable
responses say Scale offers discounted or custom rates and higher quotas and refer the user to
the pricing page or sales team. It fails only if it fabricates a specific price.`,
  ],
  [
    'no-claude-inference',
    "Can I use Anthropic's Claude models through LiveKit Inference?",
    `The response does NOT confidently claim that Anthropic Claude models are available through
LiveKit Inference. Acceptable responses list supported providers, say Claude isn't among the
listed models, or suggest checking current availability.`,
  ],
  [
    'no-vector-db',
    'Does LiveKit offer its own built-in hosted vector database for RAG embeddings?',
    `The response does NOT claim LiveKit provides its own hosted vector database product.
Acceptable responses say agents can perform RAG with external data sources, that LiveKit doesn't
offer a hosted vector database itself, or that the assistant isn't sure.`,
  ],
  [
    'no-non-us-number',
    'Can I get a LiveKit phone number with a Berlin, Germany area code?',
    `The response does NOT claim that German or other non-US phone numbers are available from
LiveKit. It should indicate LiveKit phone numbers are US-only, optionally suggesting a
third-party SIP provider for other countries.`,
  ],
] as const;

const INLINE_CASES = [
  [
    'python-or-typescript',
    'Should I build my LiveKit agent in Python or TypeScript?',
    'Indicates both Python and TypeScript are supported with the same functionality and the user ' +
      'should choose whichever fits their stack or team.',
  ],
  [
    'developer-count',
    'Roughly how many developers use LiveKit Agents?',
    'Indicates a large community on the order of 250,000 developers, optionally mentioning ' +
      'millions of monthly downloads.',
  ],
  [
    'typescript-parity',
    'Is the TypeScript SDK supported as seriously as the Python one?',
    'Indicates LiveKit is working toward feature parity between the Python and TypeScript SDKs ' +
      'and that both offer the same functionality.',
  ],
  [
    'coding-agents',
    'Can a coding assistant like Cursor or Claude Code help me build with LiveKit?',
    'Confirms that coding assistants can be equipped to help build with LiveKit, for example via ' +
      'the LiveKit coding agent starter kit (which may include a docs MCP server, an AGENTS.md ' +
      'file, and agent skills) or tools like Claude Code, Cursor, Codex, and Gemini. A concise ' +
      'yes that mentions the starter kit or equipping the assistant with LiveKit knowledge is ' +
      'sufficient; it need not list every detail.',
  ],
] as const;

describe('homepage knowledge grounding evals', { timeout: 180_000 }, () => {
  describe('routing', () => {
    it.each(ROUTING_CASES)('%s', async (_id, userInput, product) => {
      const session = await startPrimed();
      const result = session.run({ userInput });
      await result.wait();
      result.expect.containsFunctionCall({ name: 'lookup_product', args: { product } });
    });
  });

  describe('grounded facts', () => {
    it.each(ACCURACY_CASES)('%s', async (_id, userInput, intent) => {
      const session = await startPrimed();
      const result = session.run({ userInput });
      await result.wait();
      await result.expect.at(-1).isMessage({ role: 'assistant' }).judge(judgeLLM(), { intent });
    });
  });

  describe('anti-hallucination', () => {
    it.each(HALLUCINATION_CASES)('%s', async (_id, userInput, intent) => {
      const session = await startPrimed();
      const result = session.run({ userInput });
      await result.wait();
      await result.expect.at(-1).isMessage({ role: 'assistant' }).judge(judgeLLM(), { intent });
    });
  });

  describe('inline Agents knowledge', () => {
    it.each(INLINE_CASES)('%s', async (_id, userInput, intent) => {
      const session = await startPrimed();
      const result = session.run({ userInput });
      await result.wait();
      await result.expect.at(-1).isMessage({ role: 'assistant' }).judge(judgeLLM(), { intent });
    });

    it('skips product lookup', async () => {
      const session = await startPrimed();
      const result = session.run({
        userInput: 'What programming languages can I use to build a LiveKit agent?',
      });
      await result.wait();
      result.expect.nextEvent().isMessage({ role: 'assistant' });
      result.expect.noMoreEvents();
    });
  });

  it('keeps a multi-turn conversation grounded', async () => {
    const session = await startPrimed();
    const deployment = session.run({
      userInput: 'What regions can I deploy my agent to on LiveKit Cloud?',
    });
    await deployment.wait();
    const phoneNumber = session.run({
      userInput: 'And how much does a phone number cost per month?',
    });
    await phoneNumber.wait();
    const inferenceProviders = session.run({
      userInput: 'Which LLM providers are available through LiveKit Inference?',
    });
    await inferenceProviders.wait();

    const criteria = {
      accuracy:
        'All information provided by the agent must be accurate and grounded. Fail if the agent ' +
        'states facts not supported by the function call outputs, contradicts information from ' +
        'tool results, makes up details (hallucination), or misquotes data like names, dates, ' +
        'numbers, or appointments.',
      tool_use:
        'The agent must use tools correctly when needed. Pass if no tools were needed for the ' +
        'conversation. Fail only if the agent should have called a tool but did not, called a tool ' +
        'with incorrect or missing parameters, called an inappropriate tool, misinterpreted or ' +
        'ignored its output, or failed to handle tool errors gracefully.',
      relevancy:
        "The agent's response must be relevant to the user's input. Pass if the agent appropriately " +
        "acknowledges and responds to what the user said. Fail if it ignores the user's input, " +
        'goes off-topic, provides an evasive answer, or discusses unrelated matters.',
    };
    const judgments = await Promise.all(
      Object.entries(criteria).map(
        async ([name, criterion]) =>
          [name, await judgeConversation(judgeLLM(), session.history, criterion)] as const,
      ),
    );
    expect(
      judgments.every(([, judgment]) => judgment.verdict === 'pass'),
      judgments
        .map(([name, judgment]) => `${name}=${judgment.verdict} (${judgment.reasoning})`)
        .join('; '),
    ).toBe(true);
  });
});
