// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Example: Summarizing context during agent handoffs.
 *
 * This example demonstrates three strategies for passing context between agents
 * during a handoff:
 *
 * 1. **Structured userData** - Store key facts in a typed object and serialize
 *    it so the next agent can read a compact snapshot.
 * 2. **Chat context copy / truncate** - Carry the previous agent's recent
 *    conversation history into the new agent for continuity.
 * 3. **LLM-powered summarization** - Use the LLM to compress older conversation
 *    turns into a short summary before handing off.
 *
 * Run with:
 *    npx tsx examples/src/handoff_context_summarization.ts dev
 */
import {
  type JobContext,
  type JobProcess,
  WorkerOptions,
  cli,
  defineAgent,
  llm,
  voice,
} from '@livekit/agents';
import * as deepgram from '@livekit/agents-plugin-deepgram';
import * as livekit from '@livekit/agents-plugin-livekit';
import * as openai from '@livekit/agents-plugin-openai';
import * as silero from '@livekit/agents-plugin-silero';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// 1. Structured userData - a typed container for facts gathered so far
// ---------------------------------------------------------------------------
type ConversationData = {
  topic?: string;
  customerName?: string;
  customerEmail?: string;
  sentiment?: string;
  keyRequirements?: string[];
  prevAgent?: voice.Agent<ConversationData>;
};

/**
 * Serialize collected data into a compact JSON string.
 * This summary is injected as a system message when the next agent starts
 * so it immediately has the full picture.
 */
function summarizeUserData(data: ConversationData): string {
  return JSON.stringify(
    {
      topic: data.topic ?? 'unknown',
      customerName: data.customerName ?? 'unknown',
      customerEmail: data.customerEmail ?? 'unknown',
      sentiment: data.sentiment ?? 'unknown',
      keyRequirements: data.keyRequirements ?? [],
    },
    null,
    2,
  );
}

// ---------------------------------------------------------------------------
// 2. Base agent with chat context merging on handoff
// ---------------------------------------------------------------------------

/**
 * Base agent that merges the previous agent's recent chat history.
 *
 * On enter, it:
 * - copies a truncated view of the previous agent's chat context
 *   (excluding system instructions and handoff markers)
 * - appends a system message with the serialized userData summary
 * - triggers an initial reply so the new agent smoothly picks up
 */
class BaseAgent extends voice.Agent<ConversationData> {
  agentName: string;

  constructor(options: voice.AgentOptions<ConversationData> & { agentName: string }) {
    const { agentName, ...opts } = options;
    super(opts);
    this.agentName = agentName;
  }

  async onEnter(): Promise<void> {
    const userData = this.session.userData;
    const chatCtx = this.chatCtx.copy();

    // Merge last few turns from the previous agent so conversational
    // continuity is preserved without blowing up token usage.
    if (userData.prevAgent) {
      const truncatedCtx = userData.prevAgent.chatCtx
        .copy({
          excludeInstructions: true, // don't carry over old system prompt
          excludeFunctionCall: false, // keep tool calls for context
          excludeHandoff: true, // strip handoff markers
        })
        .truncate(6); // keep only the last ~3 turns (user+assistant)

      // de-duplicate by item id to avoid repeating messages already present
      const existingIds = new Set(chatCtx.items.map((item) => item.id));
      const newItems = truncatedCtx.items.filter((item) => !existingIds.has(item.id));
      chatCtx.items.push(...newItems);
    }

    // Inject a system message with the structured data summary so
    // the agent knows everything collected so far.
    chatCtx.addMessage({
      role: 'system',
      content: `You are the ${this.agentName} agent. Here is the current state of the conversation:\n${summarizeUserData(userData)}`,
    });

    await this.updateChatCtx(chatCtx);
    this.session.generateReply({ toolChoice: 'none' });
  }
}

// ---------------------------------------------------------------------------
// 3. LLM-powered summarization before handoff + agent definitions
// ---------------------------------------------------------------------------

class TriageAgent extends voice.Agent<ConversationData> {
  async onEnter() {
    this.session.generateReply();
  }

  static create() {
    return new TriageAgent({
      instructions: [
        'You are a friendly triage agent. Your job is to:',
        '1. Greet the user and learn their name.',
        '2. Understand what topic they need help with.',
        '3. Gauge their sentiment (happy, neutral, frustrated).',
        'Once you have this info, call the `transferToSpecialist` tool.',
      ].join('\n'),
      tools: {
        updateCustomerInfo: llm.tool({
          description: "Store the customer's name and email.",
          parameters: z.object({
            name: z.string().describe("The customer's name"),
            email: z.string().describe("The customer's email address"),
          }),
          execute: async ({ name, email }, { ctx }) => {
            ctx.userData.customerName = name;
            ctx.userData.customerEmail = email;
            return `Stored customer info: ${name} <${email}>`;
          },
        }),
        transferToSpecialist: llm.tool({
          description: 'Hand the conversation to a specialist once triage is complete.',
          parameters: z.object({
            topic: z
              .string()
              .describe('The topic the user needs help with (e.g. billing, technical, general)'),
            sentiment: z
              .string()
              .describe("The user's current sentiment (happy, neutral, frustrated)"),
          }),
          execute: async ({ topic, sentiment }, { ctx }) => {
            ctx.userData.topic = topic;
            ctx.userData.sentiment = sentiment;

            // --- Strategy 3: LLM-powered summarization ---
            // Before handing off, compress the chat history so the specialist
            // gets a concise summary rather than the full transcript.
            // _summarize keeps the last `keepLastTurns` user/assistant pairs
            // verbatim and compresses everything older into a short paragraph.
            const currentAgent = ctx.session.currentAgent;
            const chatCtx = currentAgent.chatCtx.copy();
            const llmInstance = ctx.session.llm;
            if (llmInstance) {
              console.log('Summarizing conversation before handoff...');
              await chatCtx._summarize(llmInstance, { keepLastTurns: 2 });
              await currentAgent.updateChatCtx(chatCtx);
              console.log('Summarization complete.');
            }

            // Store reference so the next agent's onEnter can merge our context
            ctx.userData.prevAgent = currentAgent;

            const specialist = SpecialistAgent.create(topic);
            return llm.handoff({
              agent: specialist,
              returns: `Transferring to ${topic} specialist`,
            });
          },
        }),
      },
    });
  }
}

class SpecialistAgent extends BaseAgent {
  async onEnter(): Promise<void> {
    // Call the base class onEnter which handles context merging + summary injection
    await super.onEnter();
  }

  static create(topic: string) {
    return new SpecialistAgent({
      agentName: 'specialist',
      instructions: [
        `You are a specialist in ${topic}.`,
        'The user has already been triaged. You have their collected info',
        'and a summary of the prior conversation in your context.',
        'Help them resolve their issue. When done, call `wrapUp`.',
      ].join(' '),
      tools: {
        recordRequirements: llm.tool({
          description: 'Record the specific requirements the user mentioned.',
          parameters: z.object({
            requirements: z.array(z.string()).describe('A list of specific requirements or issues'),
          }),
          execute: async ({ requirements }, { ctx }) => {
            ctx.userData.keyRequirements = requirements;
            return `Recorded ${requirements.length} requirement(s).`;
          },
        }),
        wrapUp: llm.tool({
          description: "Wrap up the conversation when the user's issue is resolved.",
          execute: async (_, { ctx }) => {
            const name = ctx.userData.customerName ?? 'there';
            ctx.session.interrupt();
            await ctx.session.generateReply({
              instructions: `Say goodbye to ${name} and let them know their issue is resolved.`,
              allowInterruptions: false,
            });
          },
        }),
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------
export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load();
  },
  entry: async (ctx: JobContext) => {
    const userData: ConversationData = {};

    const session = new voice.AgentSession({
      vad: ctx.proc.userData.vad! as silero.VAD,
      stt: new deepgram.STT(),
      llm: new openai.LLM({ model: 'gpt-4.1-mini' }),
      tts: new openai.TTS(),
      userData,
      turnDetection: new livekit.turnDetector.EnglishModel(),
    });

    await session.start({
      agent: TriageAgent.create(),
      room: ctx.room,
    });
  },
});

cli.runApp(new WorkerOptions({ agent: fileURLToPath(import.meta.url) }));
