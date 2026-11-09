// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Warm transfer that shows the supervisor the customer's number on Twilio Elastic SIP Trunking.
 *
 * Twilio-only variant of ./warm_transfer.ts. It needs an outbound trunk that terminates on Twilio
 * Elastic SIP Trunking and Twilio's CallToken beta. For any other SIP provider, use
 * ./warm_transfer.ts.
 */
import {
  type JobContext,
  ServerOptions,
  cli,
  defineAgent,
  getJobContext,
  inference,
  llm,
  log,
  voice,
  workflows,
} from '@livekit/agents';
import { BackgroundVoiceCancellation } from '@livekit/noise-cancellation-node';
import { ParticipantKind, type RemoteParticipant, RoomEvent } from '@livekit/rtc-node';
import { fileURLToPath } from 'node:url';

const SIP_TRUNK_ID = process.env.LIVEKIT_SIP_OUTBOUND_TRUNK;
const SUPERVISOR_PHONE_NUMBER = process.env.LIVEKIT_SUPERVISOR_PHONE_NUMBER;
const SIP_NUMBER = process.env.LIVEKIT_SIP_NUMBER; // fallback caller ID

type CallerId = { sipNumber?: string; sipHeaders?: Record<string, string> };

// Shows the supervisor the inbound caller's number. Reads X-Twilio-CallToken from the caller's
// SIP leg and forwards it as-is with the caller's number from the same call. Falls back to the
// business number when either is unavailable. RPC responses are recorded in traces as PII (`lk.pii.rpc.response`), so keep
// PII redaction on if you export traces.
// https://www.twilio.com/en-us/changelog/elastic-sip-trunking---immutable-call-forwarding-with-calltoken-
async function twilioCallerId(caller: RemoteParticipant | undefined): Promise<CallerId> {
  const fallback: CallerId = { sipNumber: SIP_NUMBER };
  const callerNumber = caller?.attributes['sip.phoneNumber'];
  const localParticipant = getJobContext().room.localParticipant;
  if (caller?.kind !== ParticipantKind.SIP || !callerNumber || !localParticipant) {
    return fallback;
  }
  try {
    const response = await localParticipant.performRpc({
      destinationIdentity: caller.identity,
      method: 'lk.sip.GetRemoteHeaders',
      payload: JSON.stringify({ include: ['X-Twilio-CallToken'] }),
    });
    const headers: Record<string, string> = JSON.parse(response).headers ?? {};
    const callToken = Object.entries(headers).find(
      ([name]) => name.toLowerCase() === 'x-twilio-calltoken',
    )?.[1];
    return callToken
      ? { sipNumber: callerNumber, sipHeaders: { 'X-Twilio-CallToken': callToken } }
      : fallback;
  } catch {
    log().warn('could not read SIP headers, using the business number');
    return fallback;
  }
}

// Waits for the participant the session would link by default: SIP, standard or connector, and
// not publishing on the agent's behalf (an avatar, for example). Egress participants are skipped,
// unlike ctx.waitForParticipant(), which returns any non-agent participant.
function waitForCaller(ctx: JobContext): Promise<RemoteParticipant> {
  const agentIdentity = ctx.room.localParticipant?.identity;
  const isCaller = (p: RemoteParticipant) =>
    voice.DEFAULT_PARTICIPANT_KINDS.includes(p.kind) &&
    p.attributes['lk.publish_on_behalf'] !== agentIdentity;

  const present = [...ctx.room.remoteParticipants.values()].find(isCaller);
  if (present) return Promise.resolve(present);
  return new Promise((resolve, reject) => {
    const onConnected = (p: RemoteParticipant) => {
      if (!isCaller(p)) return;
      cleanup();
      resolve(p);
    };
    const onDisconnected = () => {
      cleanup();
      reject(new Error('room disconnected before the caller joined'));
    };
    const cleanup = () => {
      ctx.room.off(RoomEvent.ParticipantConnected, onConnected);
      ctx.room.off(RoomEvent.Disconnected, onDisconnected);
    };
    ctx.room.on(RoomEvent.ParticipantConnected, onConnected);
    ctx.room.on(RoomEvent.Disconnected, onDisconnected);
  });
}

class SupportAgent extends voice.Agent {
  constructor(caller: RemoteParticipant | undefined) {
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
            const logger = log().child({ example: 'twilio-sip-trunk-warm-transfer' });
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

              const result = await new workflows.WarmTransferTask({
                sipCallTo: SUPERVISOR_PHONE_NUMBER,
                sipTrunkId: SIP_TRUNK_ID,
                ...(await twilioCallerId(caller)),
                chatCtx: ctx.session.history,
                // Give up if the supervisor doesn't pick up within 25s with
                // `ringingTimeout: 25000`.
                instructions: { extra: SUMMARY_INSTRUCTIONS },
                greetingSpeech: (session) => session.generateReply({ toolChoice: 'none' }),
                callerHangupSpeech: 'The caller has disconnected. I am ending this call now.',
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

    // Link the session to the caller explicitly so the transfer reads the same participant.
    // Console mode has no room participant, so the business number is used there.
    await ctx.connect();
    const caller = ctx.room.isConnected ? await waitForCaller(ctx) : undefined;

    await session.start({
      agent: new SupportAgent(caller),
      room: ctx.room,
      inputOptions: {
        noiseCancellation: BackgroundVoiceCancellation(),
        participantIdentity: caller?.identity,
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
If the transfer fails, tell the user that they could not be connected and offer further help.
Only announce a successful connection after the transfer succeeds.
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
// including the human agent room that WarmTransferTask creates — which puts a
// second agent on the line with the human agent and produces overlapping voices.
cli.runApp(
  new ServerOptions({
    agent: fileURLToPath(import.meta.url),
    agentName: process.env.AGENT_DISPATCH_NAME ?? 'warm-transfer',
  }),
);
