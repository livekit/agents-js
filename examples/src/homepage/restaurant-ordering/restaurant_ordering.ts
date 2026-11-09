// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
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
import {
  DeliveryUpdate,
  GREETING,
  PERSONA,
  TakeOrder,
  callerScript,
  deliveryOpener,
} from './order_desk.js';
import { PHONE, dialPhone, outboundLine } from './phone.js';
import { Pizzeria } from './pizzeria.js';
import { onSimulationEnd, setupSimulation } from './simulation.js';
import { SUGGESTIONS_MODEL, SuggestedReplies } from './suggested_replies.js';

export const AGENT_NAME = 'restaurant-ordering';
const STT_MODEL = 'assemblyai/universal-3-6-pro',
  LLM_MODEL = 'google/gemma-4-31b-it',
  TTS_MODEL = 'fishaudio/s2.1-pro';
const VOICE = '9a9cf47702da476aa4629e2506d4a857';
const KEYTERMS = [
  "Zappi's",
  'Gabby',
  'pepperoni',
  'margherita',
  'Hawaiian',
  'meat lovers',
  'boneless',
  'breadsticks',
  'Caesar',
  'caprese',
  'tiramisu',
  'cannoli',
  'Marco',
];
const STILL_THERE = 'Are you still there?',
  SILENT_GOODBYE = "I'll let you go. Give us a call back anytime.";

export default defineAgent({
  onSimulationEnd,
  entry: async (ctx: JobContext) => {
    const raw = ctx.job.metadata ? (JSON.parse(ctx.job.metadata) as Record<string, unknown>) : {};
    const meta: Record<string, unknown> = {
      // The console-only override mirrors the source example's local debugging switch.
      // eslint-disable-next-line turbo/no-undeclared-env-vars
      direction: process.env.CALL_DIRECTION,
      ...raw,
      ...(ctx.simulationContext()?.userdata() ?? {}),
    };
    const outbound = meta.direction === 'outbound';
    await ctx.connect();
    if (typeof meta.dial === 'string') {
      const [trunk, from] = outboundLine(meta);
      if (!(await dialPhone(ctx, meta.dial, trunk, from))) {
        await ctx.deleteRoom();
        return;
      }
    }
    const phone = [...ctx.room.remoteParticipants.values()].find(
      (p) => p.kind === ParticipantKind.SIP,
    );
    const publish = async (parts: Record<string, unknown>) => {
      await ctx.room.localParticipant!.setAttributes(
        Object.fromEntries(
          Object.entries(parts).map(([key, value]) => [`restaurant.${key}`, JSON.stringify(value)]),
        ),
      );
    };
    const pos = outbound
      ? Pizzeria.outForDelivery(typeof meta.name === 'string' ? meta.name : null, publish)
      : new Pizzeria(publish);
    await publish({
      call: {
        channel: phone ? 'phone' : 'browser',
        direction: outbound ? 'outbound' : 'inbound',
        models: { stt: STT_MODEL, llm: LLM_MODEL, tts: TTS_MODEL },
      },
    });
    await pos.publishAll();
    const sim = ctx.simulationContext();
    if (sim) setupSimulation(sim, pos);
    const session = new voice.AgentSession<Pizzeria>({
      userData: pos,
      stt: new inference.STT({ model: STT_MODEL, language: 'en' }),
      llm: new inference.LLM({ model: LLM_MODEL }),
      tts: new inference.TTS({ model: TTS_MODEL, voice: VOICE }),
      turnDetection: new inference.TurnDetector(),
      turnHandling: { interruption: { mode: 'adaptive' }, preemptiveGeneration: { enabled: true } },
      keytermsOptions: { keyterms: KEYTERMS, keytermDetection: { enabled: true } },
      expressive: true,
      tools: [
        beta.createEndCallTool({
          endInstructions:
            "Say what any tool called with this one returned, then a short goodbye if you haven't said one.",
        }),
      ],
    });
    if (!ctx.isFakeJob) checkInWhenUserAway(session);
    new SuggestedReplies(
      session,
      ctx.room,
      new inference.LLM({ model: SUGGESTIONS_MODEL }),
      PERSONA,
      () => callerScript(pos),
    ).attach();
    await session.start({
      agent: outbound ? new DeliveryUpdate(pos) : new TakeOrder(pos),
      room: ctx.room,
      inputOptions: {
        participantIdentity: typeof meta.dial === 'string' ? PHONE : undefined,
        deleteRoomOnClose: true,
        noiseCancellation: BackgroundVoiceCancellation(),
      },
    });
    if (phone) {
      try {
        await waitForParticipantAttribute({
          room: ctx.room,
          identity: phone.identity,
          attribute: 'sip.callStatus',
          value: 'active',
        });
      } catch {
        ctx.shutdown('the call was not answered');
        return;
      }
    }
    session.say(outbound ? deliveryOpener(pos) : GREETING);
  },
});

function checkInWhenUserAway(session: voice.AgentSession): void {
  type CheckIn = { controller: AbortController; speech?: voice.SpeechHandle };
  let checkIn: CheckIn | undefined;
  session.on(voice.AgentSessionEventTypes.UserStateChanged, (event) => {
    checkIn?.controller.abort();
    if (checkIn?.speech && !checkIn.speech.done()) checkIn.speech.interrupt(true);
    checkIn = undefined;
    if (event.newState !== 'away') return;

    const current: CheckIn = { controller: new AbortController() };
    checkIn = current;
    const signal = current.controller.signal;
    void (async () => {
      try {
        current.speech = session.say(STILL_THERE);
        await current.speech.waitForPlayout();
        current.speech = undefined;
        if (signal.aborted) return;
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(
            resolve,
            (session.sessionOptions.userAwayTimeout ?? 15) * 1000,
          );
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
        current.speech = session.say(SILENT_GOODBYE, { allowInterruptions: false });
        await current.speech.waitForPlayout();
        current.speech = undefined;
        if (!signal.aborted) session.shutdown();
      } finally {
        if (checkIn === current) checkIn = undefined;
      }
    })();
  });
}
cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url), agentName: AGENT_NAME }));
