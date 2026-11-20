// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  AgentSessionEventTypes,
  type JobContext,
  ServerOptions,
  beta,
  cli,
  defineAgent,
  inference,
  voice,
  waitForParticipantAttribute,
} from '@livekit/agents';
import { BackgroundVoiceCancellation } from '@livekit/noise-cancellation-node';
import { ParticipantKind } from '@livekit/rtc-node';
import { fileURLToPath } from 'node:url';
import { Clinic } from './clinic.js';
import { dialPhone, outboundLine } from './phone.js';
import {
  ConfirmationCall,
  GREETING,
  Receptionist,
  callerScript,
  newCallState,
  outboundCallerScript,
  outboundGreeting,
} from './receptionist.js';
import { onSimulationEnd, setupSimulation } from './simulation.js';
import { SUGGESTIONS_MODEL, SuggestedReplies } from './suggested_replies.js';

export const AGENT_NAME = 'homepage-front-desk';
export const STT_MODEL = 'assemblyai/universal-3-6-pro';
export const LLM_MODEL = 'google/gemma-4-31b-it';
export const TTS_MODEL = 'rime/coda';
export const VOICE = 'eyre';
export const KEYTERMS = ['Juniper Health', 'Okafor', 'Riley'];

export const STILL_THERE = 'Are you still there?';
export const SILENT_GOODBYE = "I'll let you go. Give us a call back anytime.";

function metadata(ctx: JobContext): Record<string, unknown> {
  let value: Record<string, unknown> = {};
  if (ctx.job.metadata) {
    const parsed = JSON.parse(ctx.job.metadata) as unknown;
    if (typeof parsed === 'object' && parsed !== null) value = parsed as Record<string, unknown>;
  }
  return { ...value, ...(ctx.simulationContext()?.userdata() ?? {}) };
}

export default defineAgent({
  entry: async (ctx: JobContext) => {
    const meta = metadata(ctx);
    const outbound = meta.direction === 'outbound';
    await ctx.connect();

    let caller;
    if (typeof meta.dial === 'string' && meta.dial) {
      caller = await dialPhone(ctx, meta.dial, ...outboundLine(meta));
      if (caller === null) {
        await ctx.deleteRoom();
        return;
      }
    } else {
      caller = await ctx.waitForParticipant();
    }
    const onPhone = caller.kind === ParticipantKind.SIP;

    const publish = async (key: string, value: unknown): Promise<void> => {
      await ctx.room.localParticipant!.setAttributes({
        [`clinic.${key}`]: JSON.stringify(value),
      });
    };
    const clinic = Clinic.forNow(publish);
    await publish('call', {
      channel: onPhone ? 'phone' : 'browser',
      direction: outbound ? 'outbound' : 'inbound',
      models: { stt: STT_MODEL, llm: LLM_MODEL, tts: TTS_MODEL },
    });

    const state = newCallState(clinic);
    const session = new voice.AgentSession({
      userData: state,
      stt: new inference.STT({ model: STT_MODEL, language: 'en' }),
      llm: new inference.LLM({ model: LLM_MODEL }),
      tts: new inference.TTS({ model: TTS_MODEL, voice: VOICE, language: 'en' }),
      keytermsOptions: { keyterms: KEYTERMS, keytermDetection: { enabled: true } },
      turnHandling: {
        turnDetection: new inference.TurnDetector(),
        interruption: { mode: 'adaptive' },
        preemptiveGeneration: { enabled: true },
      },
      tools: [
        beta.createEndCallTool({
          endInstructions:
            "Say what any tool called with this one returned, then a short goodbye if you haven't said one.",
        }),
      ],
    });
    const confirming = clinic.appointments[0];
    if (!confirming) throw new Error('clinic seed requires a confirmation appointment');

    const simulation = ctx.simulationContext();
    if (simulation) setupSimulation(simulation, state);
    if (!ctx.isFakeJob) checkInWhenUserAway(session);
    new SuggestedReplies(
      session,
      ctx.room,
      new inference.LLM({ model: SUGGESTIONS_MODEL }),
      'Riley',
      () =>
        outbound
          ? outboundCallerScript(clinic, session.userData, confirming)
          : callerScript(clinic, session.userData),
    ).attach();

    await session.start({
      agent: outbound ? new ConfirmationCall(clinic, confirming) : new Receptionist(clinic),
      room: ctx.room,
      inputOptions: {
        participantIdentity: caller.identity,
        deleteRoomOnClose: true,
        noiseCancellation: BackgroundVoiceCancellation(),
      },
    });

    if (onPhone) {
      try {
        await waitForParticipantAttribute({
          room: ctx.room,
          identity: caller.identity,
          attribute: 'sip.callStatus',
          value: 'active',
        });
      } catch {
        ctx.shutdown('the call was not answered');
        return;
      }
    }
    session.say(outbound ? outboundGreeting(confirming) : GREETING);
  },
  onSimulationEnd,
});

export function checkInWhenUserAway(session: voice.AgentSession): void {
  let controller: AbortController | undefined;
  session.on(AgentSessionEventTypes.UserStateChanged, (event) => {
    controller?.abort();
    controller = undefined;
    if (event.newState !== 'away') return;

    controller = new AbortController();
    const signal = controller.signal;
    void (async () => {
      await session.say(STILL_THERE).waitForPlayout();
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, (session.sessionOptions.userAwayTimeout ?? 15) * 1000);
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timeout);
            resolve();
          },
          { once: true },
        );
      });
      if (signal.aborted) return;
      await session.say(SILENT_GOODBYE, { allowInterruptions: false }).waitForPlayout();
      session.shutdown();
    })();
  });
}

cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url), agentName: AGENT_NAME }));
