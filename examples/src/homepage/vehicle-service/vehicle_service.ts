// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type JobContext,
  ServerOptions,
  beta,
  cli,
  defineAgent,
  delay,
  inference,
  voice,
  waitForParticipantAttribute,
} from '@livekit/agents';
import { BackgroundVoiceCancellation } from '@livekit/noise-cancellation-node';
import { ParticipantKind } from '@livekit/rtc-node';
import { fileURLToPath } from 'node:url';
import {
  GREETING,
  RepairCallback,
  ServiceAdvisor,
  callbackOpener,
  callerScript,
} from './advisor.js';
import { PHONE, dialPhone, outboundLine } from './phone.js';
import { ServiceDesk, todayIn } from './service_desk.js';
import { onSimulationEnd, setupSimulation } from './simulation.js';
import { SUGGESTIONS_MODEL, SuggestedReplies } from './suggested_replies.js';

const AGENT_NAME = 'vehicle-service';
const STT_MODEL = 'assemblyai/universal-3-6-pro';
const LLM_MODEL = 'google/gemma-4-31b-it';
const TTS_MODEL = 'rime/coda';
const VOICE = 'thread';
const KEYTERMS = ['Bayside', 'BMW', 'X3', '330i', 'xDrive', 'recall', 'Nick'];
const STILL_THERE = 'Are you still there?';
const SILENT_GOODBYE = "I'll let you go. Give us a call back anytime.";

export default defineAgent({
  entry: async (ctx: JobContext) => {
    const metadata = ctx.job.metadata
      ? (JSON.parse(ctx.job.metadata) as Record<string, unknown>)
      : {};
    const simulation = ctx.simulationContext();
    const meta: Record<string, unknown> = {
      // eslint-disable-next-line turbo/no-undeclared-env-vars
      direction: process.env.CALL_DIRECTION,
      // eslint-disable-next-line turbo/no-undeclared-env-vars
      today: process.env.SERVICE_DESK_TODAY,
      ...metadata,
      ...simulation?.userdata(),
    };
    const today =
      typeof meta.today === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(meta.today)
        ? meta.today
        : todayIn(typeof meta.timezone === 'string' ? meta.timezone : undefined);
    const callback = meta.direction === 'outbound';
    await ctx.connect();
    const dial = typeof meta.dial === 'string' ? meta.dial : undefined;
    if (dial && !(await dialPhone(ctx, dial, ...outboundLine(meta)))) {
      await ctx.deleteRoom();
      return;
    }
    const phone = [...ctx.room.remoteParticipants.values()].find(
      (participant) => participant.kind === ParticipantKind.SIP,
    );
    const publish = async (key: string, value: unknown): Promise<void> => {
      await ctx.room.localParticipant!.setAttributes({ [`service.${key}`]: JSON.stringify(value) });
    };
    const desk = callback
      ? ServiceDesk.forCallback(today, publish)
      : new ServiceDesk(today, publish);
    await publish('call', {
      channel: phone ? 'phone' : 'browser',
      direction: callback ? 'outbound' : 'inbound',
      models: { stt: STT_MODEL, llm: LLM_MODEL, tts: TTS_MODEL },
    });
    await desk.publishAll();
    const session = new voice.AgentSession<ServiceDesk>({
      userData: desk,
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
    if (!ctx.isFakeJob) checkInWhenUserAway(session);
    new SuggestedReplies(
      session,
      ctx.room,
      new inference.LLM({ model: SUGGESTIONS_MODEL }),
      'Nick',
      () => callerScript(desk),
    ).attach();
    if (simulation) setupSimulation(simulation, session);
    await session.start({
      agent: callback ? new RepairCallback(desk) : new ServiceAdvisor(desk),
      room: ctx.room,
      inputOptions: {
        participantIdentity: dial ? PHONE : undefined,
        noiseCancellation: BackgroundVoiceCancellation(),
        deleteRoomOnClose: true,
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
    session.say(callback ? callbackOpener(desk) : GREETING);
  },
  onSimulationEnd,
});

function checkInWhenUserAway(session: voice.AgentSession): void {
  let controller: AbortController | undefined;
  session.on(voice.AgentSessionEventTypes.UserStateChanged, (event) => {
    controller?.abort();
    if (event.newState !== 'away') return;
    controller = new AbortController();
    const signal = controller.signal;
    void (async () => {
      try {
        await session.say(STILL_THERE).waitForPlayout();
        await delay((session.sessionOptions.userAwayTimeout ?? 15) * 1000, { signal });
        await session.say(SILENT_GOODBYE, { allowInterruptions: false }).waitForPlayout();
        session.shutdown();
      } catch {
        /* A resumed caller cancels the check-in. */
      }
    })();
  });
}

cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url), agentName: AGENT_NAME }));
