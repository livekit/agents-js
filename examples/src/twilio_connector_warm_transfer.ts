// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Warm transfer with the supervisor dialed through the Twilio connector.
 *
 * Same support agent as ../warm_transfer.ts, but the escalation runs
 * TwilioConnectorWarmTransferTask: connectTwilioCall opens an outbound
 * connector session and the Twilio REST API places the supervisor call with
 * TwiML that streams it into the session, so no SIP trunk is needed.
 */
import {
  type JobContext,
  ServerOptions,
  cli,
  defineAgent,
  inference,
  llm,
  log,
  voice,
  workflows,
} from '@livekit/agents';
import { BackgroundVoiceCancellation } from '@livekit/noise-cancellation-node';
import { fileURLToPath } from 'node:url';

// LiveKit credentials are read from LIVEKIT_URL, LIVEKIT_API_KEY, and
// LIVEKIT_API_SECRET. Twilio REST credentials and caller ID:
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID; // "ACxxxx..."
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER; // your Twilio number, shown to the supervisor
const SUPERVISOR_PHONE_NUMBER = process.env.LIVEKIT_SUPERVISOR_PHONE_NUMBER; // "+12003004000"

class SupportAgent extends voice.Agent {
  constructor() {
    super({
      instructions: INSTRUCTIONS,
      tools: [
        llm.tool({
          name: 'transfer_to_human',
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
            const logger = log().child({ example: 'twilio-connector-warm-transfer' });
            logger.info('tool called to transfer to human');
            const holdSpeech = ctx.session.say(
              'Please hold while I connect you to a human agent.',
              { allowInterruptions: false },
            );
            await holdSpeech.waitForPlayout();

            try {
              if (!SUPERVISOR_PHONE_NUMBER || !TWILIO_FROM_NUMBER) {
                throw new Error(
                  'LIVEKIT_SUPERVISOR_PHONE_NUMBER and TWILIO_FROM_NUMBER must be set',
                );
              }

              const result = await new workflows.TwilioConnectorWarmTransferTask({
                phoneNumber: SUPERVISOR_PHONE_NUMBER,
                twilioFromNumber: TWILIO_FROM_NUMBER,
                twilioAccountSid: TWILIO_ACCOUNT_SID,
                twilioAuthToken: TWILIO_AUTH_TOKEN,
                chatCtx: ctx.session.history,
                // Give up if the supervisor doesn't pick up within 25s with
                // `ringingTimeout: 25000` (default: 30s).
                instructions: { extra: SUMMARY_INSTRUCTIONS },
                greetingSpeech: (session) => session.generateReply({ toolChoice: 'none' }),
              }).run();

              logger.info(
                { humanAgentIdentity: result.humanAgentIdentity },
                'transfer to human agent successful',
              );
              const goodbyeSpeech = ctx.session.say(
                "you are on the line with a human agent. I'll be hanging up now.",
                { allowInterruptions: false },
              );
              await goodbyeSpeech.waitForPlayout();
              ctx.session.shutdown();
            } catch (error) {
              if (error instanceof llm.ToolError) {
                logger.error({ error }, 'failed to transfer to human agent with tool error');
                throw error;
              }

              logger.error({ error }, 'failed to transfer to human agent');
              throw new llm.ToolError(`failed to transfer to human agent with error: ${error}`);
            }
          },
        }),
      ],
    });
  }

  async onEnter(): Promise<void> {
    this.session.generateReply();
  }
}

// No prewarm hook needed: the local EOT model runs in the shared inference
// process (loaded once per host), and the inference VAD (~2MB, in-process)
// lazy-loads on first stream.
export default defineAgent({
  entry: async (ctx: JobContext) => {
    const session = new voice.AgentSession({
      vad: new inference.VAD(),
      llm: new inference.LLM({ model: 'openai/gpt-4.1-mini' }),
      stt: new inference.STT({ model: 'deepgram/nova-3', language: 'en' }),
      tts: new inference.TTS({
        model: 'cartesia/sonic-3',
        voice: '9626c31c-bec5-4cca-baa8-f8ba9e84c8bc',
      }),
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

// IMPORTANT: set `agentName` so this worker uses EXPLICIT dispatch. Without it,
// the worker auto-dispatches an agent into EVERY new room in the project —
// including the human agent room that the transfer task creates — which puts a
// second agent on the line with the human agent and produces overlapping voices.
cli.runApp(
  new ServerOptions({
    agent: fileURLToPath(import.meta.url),
    agentName: process.env.AGENT_DISPATCH_NAME ?? 'telephony-support-agent',
  }),
);
