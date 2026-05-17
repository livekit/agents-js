// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type JobContext,
  type JobProcess,
  ServerOptions,
  beta,
  cli,
  defineAgent,
  inference,
  llm,
  log,
  voice,
} from '@livekit/agents';
import * as livekit from '@livekit/agents-plugin-livekit';
import * as silero from '@livekit/agents-plugin-silero';
import { BackgroundVoiceCancellation } from '@livekit/noise-cancellation-node';
import { fileURLToPath } from 'node:url';

const SIP_TRUNK_ID = process.env.LIVEKIT_SIP_OUTBOUND_TRUNK;
const SUPERVISOR_PHONE_NUMBER = process.env.LIVEKIT_SUPERVISOR_PHONE_NUMBER;
const SIP_NUMBER = process.env.LIVEKIT_SIP_NUMBER;

class SupportAgent extends voice.Agent {
  constructor() {
    super({
      instructions: INSTRUCTIONS,
      tools: {
        transfer_to_human: llm.tool({
          description: `Called when the user asks to speak to a human agent. This will put the user on hold while the supervisor is connected.

Ensure that the user has confirmed that they wanted to be transferred. Do not start transfer until the user has confirmed.
Examples on when the tool should be called:
----
- User: Can I speak to your supervisor?
- Assistant: Yes of course.
----
- Assistant: I'm unable to help with that, would you like to speak to a human agent?
- User: Yes please.
----`,
          execute: async (_, { ctx }) => {
            const logger = log().child({ example: 'warm-transfer' });
            logger.info('tool called to transfer to human');
            const holdSpeech = ctx.session.say(
              'Please hold while I connect you to a human agent.',
              { allowInterruptions: false },
            );
            await holdSpeech.waitForPlayout();

            try {
              if (!SIP_TRUNK_ID || !SUPERVISOR_PHONE_NUMBER) {
                throw new Error(
                  'LIVEKIT_SIP_OUTBOUND_TRUNK and LIVEKIT_SUPERVISOR_PHONE_NUMBER must be set',
                );
              }

              const result = await new beta.WarmTransferTask({
                sipCallTo: SUPERVISOR_PHONE_NUMBER,
                sipTrunkId: SIP_TRUNK_ID,
                sipNumber: SIP_NUMBER,
                chatCtx: ctx.session.history,
                // Give up if the supervisor doesn't pick up within 25s with
                // `ringingTimeout: 25000`.
                extraInstructions: SUMMARY_INSTRUCTIONS,
              }).run();

              logger.info(
                { supervisorIdentity: result.humanAgentIdentity },
                'transfer to supervisor successful',
              );
              const goodbyeSpeech = ctx.session.say(
                "you are on the line with my supervisor. I'll be hanging up now.",
                { allowInterruptions: false },
              );
              await goodbyeSpeech.waitForPlayout();
              ctx.session.shutdown();
            } catch (error) {
              if (error instanceof llm.ToolError) {
                logger.error({ error }, 'failed to transfer to supervisor with tool error');
                throw error;
              }

              logger.error({ error }, 'failed to transfer to supervisor');
              throw new llm.ToolError(`failed to transfer to supervisor with error: ${error}`);
            }
          },
        }),
      },
    });
  }

  async onEnter(): Promise<void> {
    this.session.generateReply();
  }
}

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load();
  },
  entry: async (ctx: JobContext) => {
    const session = new voice.AgentSession({
      vad: ctx.proc.userData.vad as silero.VAD,
      llm: new inference.LLM({ model: 'openai/gpt-4.1-mini' }),
      stt: new inference.STT({ model: 'deepgram/nova-3', language: 'en' }),
      tts: new inference.TTS({
        model: 'cartesia/sonic-3',
        voice: '9626c31c-bec5-4cca-baa8-f8ba9e84c8bc',
      }),
      turnDetection: new livekit.turnDetector.MultilingualModel(),
    });

    await session.start({
      agent: new SupportAgent(),
      room: ctx.room,
      inputOptions: {
        noiseCancellation: BackgroundVoiceCancellation(),
      },
    });
  },
});

const INSTRUCTIONS = `
# Personality

You are friendly and helpful, with a welcoming personality
You're naturally curious, empathetic, and intuitive, always aiming to deeply understand the user's intent by actively listening.

# Environment

You are engaged in a live, spoken dialogue over the phone.
There are no other ways of communication with the user (no chat, text, visual, etc)

# Tone

Your responses are warm, measured, and supportive, typically 1-2 sentences to maintain a comfortable pace.
You speak with gentle, thoughtful pacing, using pauses (marked by "...") when appropriate to let emotional moments breathe.
You naturally include subtle conversational elements like "Hmm," "I see," and occasional rephrasing to sound authentic.
You actively acknowledge feelings ("That sounds really difficult...") and check in regularly ("How does that resonate with you?").
You vary your tone to match the user's emotional state, becoming calmer and more deliberate when they express distress.

# Identity

You are a customer support agent for LiveKit.

# Transferring to a human

In some cases, the user may ask to speak to a human agent. This could happen when you are unable to answer their question.
When such is requested, you would always confirm with the user before initiating the transfer.
`;

const SUMMARY_INSTRUCTIONS = `
Introduce the conversation from your perspective as the AI assistant who participated in this call:

WHO you're talking to (name, role, company if mentioned)
WHY they contacted you (goal, problem, request)
WHY a human agent is requested or needed at this point
Brief summary in 100-200 characters from a first-person perspective
`;

cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url), agentName: 'sip-inbound' }));
