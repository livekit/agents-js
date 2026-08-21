// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  Agent,
  AgentSession,
  AgentTask,
  type ChatContext,
  type JobContext,
  type LLMStream,
  type RunContext,
  ServerOptions,
  ToolFlag,
  cli,
  defineAgent,
  delay,
  inference,
  log,
  tool,
} from '@livekit/agents';
import type * as silero from '@livekit/agents-plugin-silero';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

type SearchResult = {
  title: string;
  body: string;
  href?: string;
};

function sample<T>(items: readonly T[], count: number): T[] {
  const shuffled = [...items].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count);
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function today(): string {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

async function collectText(stream: LLMStream, signal?: AbortSignal): Promise<string> {
  let text = '';

  const onAbort = () => stream.close();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    for await (const chunk of stream) {
      if (signal?.aborted) break;
      if (chunk.delta?.content) {
        text += chunk.delta.content;
      }
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    stream.close();
  }
  return text;
}

function compactHistory(chatCtx: ChatContext): string {
  return chatCtx.items
    .slice(-8)
    .map((item) => {
      if (item.type === 'message') {
        return `${item.role}: ${item.textContent ?? ''}`;
      }
      if (item.type === 'function_call_output') {
        return `tool ${item.name}: ${item.output}`;
      }
      return item.type;
    })
    .join('\n');
}

function createGetEmailTask(extraInstructions: string): AgentTask<{ emailAddress: string }> {
  const task = AgentTask.create<{ emailAddress: string }>({
    instructions:
      'You collect the user email address for a flight booking. ' +
      `${extraInstructions} As soon as you have the email, call save_email.`,
    tools: [
      tool({
        name: 'save_email',
        description: 'Save the user email address.',
        parameters: z.object({
          emailAddress: z.string().describe('The user email address'),
        }),
        execute: async ({ emailAddress }) => {
          task.complete({ emailAddress });
          return `Saved email address ${emailAddress}.`;
        },
      }),
    ],
    onEnter: (ctx) => {
      ctx.session.generateReply({
        instructions:
          'Ask the user for their email address in one short sentence, then call save_email.',
      });
    },
  });
  return task;
}

function createTravelAgent() {
  const logger = log();
  const thinkingLLM = new inference.LLM({
    model: 'openai/gpt-5.4',
    modelOptions: { reasoning_effort: 'medium' },
  });
  let userEmail: string | null = null;

  async function bookFlight(
    {
      origin,
      destination,
      date,
    }: {
      origin: string;
      destination: string;
      date: string;
    },
    ctx: RunContext,
    signal: AbortSignal,
  ): Promise<string> {
    await ctx.update(
      `Searching flights from ${origin} to ${destination} on ${date}. ` +
        'This will take a couple of minutes.',
    );

    await ctx.filler(
      'Still searching flight inventory, hang tight.',
      { delay: 5_000, signal },
      () => delay(30_000, { signal }),
    );

    const airlines = sample(['United', 'Delta', 'American', 'JetBlue', 'Southwest', 'Alaska'], 3);
    const prices = Object.fromEntries(airlines.map((airline) => [airline, randomInt(180, 650)]));
    const cheapest = airlines.reduce((best, airline) =>
      prices[airline]! < prices[best]! ? airline : best,
    );

    logger.info({ airlines, prices, cheapest }, 'Found airlines and prices');

    await ctx.update(
      `Found ${airlines.length} options. Best price: $${prices[cheapest]} on ${cheapest}. ` +
        'Confirming the booking now.',
    );

    if (!userEmail) {
      logger.info('Getting user email address');
      const email = await ctx.foreground(async () => {
        ctx.session.say('We will need your email address to confirm the flight booking.');
        return createGetEmailTask(
          'You are capturing the email address of the user for the flight booking.',
        ).run();
      });
      // The foreground hold can resolve right as we're cancelled; bail before the
      // final wait so a cancelled booking doesn't push a confirmation.
      if (signal.aborted) throw new Error('aborted');
      userEmail = email.emailAddress;
      logger.info({ email: userEmail }, 'Captured user email address');
    }

    const confirmationFillers = [
      'Still confirming the booking.',
      "Almost there, I'm finalizing the reservation.",
    ];
    await ctx.filler(
      (step) => confirmationFillers[step],
      { delay: 5_000, interval: 10_000, maxSteps: confirmationFillers.length, signal },
      () => delay(40_000, { signal }),
    );

    const confirmation = `FL-${randomInt(100000, 999999)}`;
    return (
      `Flight booked! ${cheapest} from ${origin} to ${destination} on ${date}. ` +
      `Price: $${prices[cheapest]}. Confirmation: ${confirmation}. ` +
      'The details will be sent to your email.'
    );
  }

  async function tourGuide(
    {
      destination,
      interests,
    }: {
      destination: string;
      interests: string;
    },
    ctx: RunContext,
    signal: AbortSignal,
  ): Promise<string> {
    await ctx.update(`Looking up the best spots in ${destination} for you.`);

    const sources = await search(destination, interests, ctx.session.history, signal);
    if (sources.length === 0) {
      return `Could not find information about ${destination}.`;
    }

    logger.info({ count: sources.length, destination }, 'Found tour guide sources');
    return summarize(destination, interests, sources, ctx.session.history, signal);
  }

  async function search(
    destination: string,
    interests: string,
    chatCtx: ChatContext,
    signal: AbortSignal,
  ): Promise<SearchResult[]> {
    logger.info({ destination, interests }, 'Planning search queries');
    const planCtx = chatCtx.copy({ excludeFunctionCall: true, excludeInstructions: true });
    planCtx.addMessage({
      role: 'system',
      content:
        'You are a travel research assistant. Output 3-4 web search queries ' +
        `to find the best places to visit, eat, and explore in ${destination} ` +
        `for someone interested in: ${interests}. ` +
        'Output only the queries, one per line, nothing else.',
    });

    const planResponse = await collectText(thinkingLLM.chat({ chatCtx: planCtx }), signal);
    const queries = planResponse
      .split('\n')
      .map((query) => query.trim())
      .filter(Boolean)
      .slice(0, 4);
    logger.info({ queries }, 'Search queries');

    const results: SearchResult[] = [];
    for (const query of queries) {
      if (signal.aborted) break;
      results.push(...(await searchDuckDuckGo(query, signal)));
    }
    return results.slice(0, 12);
  }

  async function searchDuckDuckGo(query: string, signal: AbortSignal): Promise<SearchResult[]> {
    const url = new URL('https://api.duckduckgo.com/');
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'json');
    url.searchParams.set('no_html', '1');
    url.searchParams.set('skip_disambig', '1');

    const response = await fetch(url, {
      headers: { accept: 'application/json' },
      signal,
    });
    if (!response.ok) {
      logger.warn({ status: response.status, query }, 'DuckDuckGo search failed');
      return [];
    }

    const payload = (await response.json()) as {
      AbstractText?: string;
      Heading?: string;
      AbstractURL?: string;
      RelatedTopics?: Array<{
        Text?: string;
        FirstURL?: string;
        Name?: string;
        Topics?: Array<{ Text?: string; FirstURL?: string }>;
      }>;
    };

    const results: SearchResult[] = [];
    if (payload.AbstractText) {
      results.push({
        title: payload.Heading || query,
        body: payload.AbstractText,
        href: payload.AbstractURL,
      });
    }

    for (const topic of payload.RelatedTopics ?? []) {
      if (topic.Text) {
        results.push({ title: topic.Name || query, body: topic.Text, href: topic.FirstURL });
      }
      for (const nested of topic.Topics ?? []) {
        if (nested.Text) {
          results.push({ title: topic.Name || query, body: nested.Text, href: nested.FirstURL });
        }
      }
    }

    if (results.length === 0) {
      results.push({
        title: query,
        body: 'No direct instant-answer result was returned. Use this query as a research lead and provide general travel guidance.',
      });
    }

    return results;
  }

  async function summarize(
    destination: string,
    interests: string,
    sources: SearchResult[],
    chatCtx: ChatContext,
    signal: AbortSignal,
  ): Promise<string> {
    const summaryCtx = chatCtx.copy({ excludeFunctionCall: true, excludeInstructions: true });
    const sourceText = sources
      .map((source) => `- ${source.title}: ${source.body}${source.href ? ` (${source.href})` : ''}`)
      .join('\n\n');

    summaryCtx.addMessage({
      role: 'system',
      content:
        `You are a local tour guide for ${destination}. The user is interested in: "${interests}". ` +
        'Based on the search results below, recommend specific places to visit, restaurants to try, ' +
        'and things to do. Be specific, with actual names and neighborhoods when available. ' +
        'This will be spoken aloud, so keep it conversational and brief: 3 to 5 top picks, ' +
        'no more than 200 words. No bullet points or markdown.\n\n' +
        `Conversation context:\n${compactHistory(chatCtx)}\n\nSearch results:\n${sourceText}`,
    });

    return collectText(thinkingLLM.chat({ chatCtx: summaryCtx }), signal);
  }

  return Agent.create({
    instructions:
      'You are a friendly travel assistant that communicates via voice. ' +
      'Avoid emojis and markdown. Speak naturally and concisely. ' +
      'You can help with two things: booking flights and recommending what to see, eat, ' +
      'and do at a destination. Use the book_flight tool when the user wants to book a ' +
      'flight. Use the tour_guide tool when the user asks about places to visit, restaurants, ' +
      'sightseeing, nightlife, or things to do somewhere. Summarize results naturally for voice. ' +
      `Today is ${today()}. When the user is not asking, do not repeat messages already said. ` +
      'Do not make up flight details or ask for flight preferences. Always use the tools.',
    tools: [
      tool({
        name: 'book_flight',
        description: 'Called when the user wants to book a flight.',
        flags: ToolFlag.CANCELLABLE,
        onDuplicate: 'confirm',
        parameters: z.object({
          origin: z.string().describe('Departure city or airport code'),
          destination: z.string().describe('Arrival city or airport code'),
          date: z.string().describe('Travel date, for example 2026-04-15'),
        }),
        execute: (args, options) => bookFlight(args, options.ctx, options.abortSignal),
      }),
      tool({
        name: 'tour_guide',
        description:
          'Called when the user asks about places to visit, restaurants, local food, nightlife, or things to do somewhere.',
        flags: ToolFlag.CANCELLABLE,
        onDuplicate: 'confirm',
        parameters: z.object({
          destination: z.string().describe('The city or area the user is visiting'),
          interests: z
            .string()
            .describe('What the user is interested in, such as street food, museums, or nightlife'),
        }),
        execute: (args, options) => tourGuide(args, options.ctx, options.abortSignal),
      }),
    ],
    onEnter: (ctx) => {
      ctx.session.generateReply({ instructions: 'Greet the user and introduce yourself.' });
    },
  });
}

export default defineAgent({
  entry: async (ctx: JobContext) => {
    const session = new AgentSession({
      vad: ctx.proc.userData.vad as silero.VAD,
      stt: new inference.STT({ model: 'deepgram/nova-3' }),
      llm: new inference.LLM({ model: 'google/gemini-3.1-flash-lite' }),
      tts: new inference.TTS({
        model: 'cartesia/sonic-3',
        voice: 'e07c00bc-4134-4eae-9ea4-1a55fb45746b',
      }),
      turnHandling: {
        interruption: {
          mode: 'adaptive',
        },
      },
    });

    await session.start({
      agent: createTravelAgent(),
      room: ctx.room,
    });
  },
});

cli.runApp(
  new ServerOptions({
    agent: fileURLToPath(import.meta.url),
  }),
);
