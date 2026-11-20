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
  log,
  voice,
  waitForTrackPublication,
} from '@livekit/agents';
import { BackgroundVoiceCancellation } from '@livekit/noise-cancellation-node';
import { TrackKind } from '@livekit/rtc-node';
import { ConnectTwilioCallRequest_TwilioCallDirection, ConnectorClient } from 'livekit-server-sdk';
import { fileURLToPath } from 'node:url';

/**
 * The same outbound AMD call as `amd.ts`, placed through Twilio and the LiveKit Twilio
 * Connector instead of a SIP trunk. Mirrors python `examples/telephony/amd_twilio_connector.py`.
 *
 * Set all four:
 *
 *   TWILIO_ACCOUNT_SID  — Twilio account SID
 *   TWILIO_AUTH_TOKEN   — Twilio auth token
 *   TWILIO_FROM_NUMBER  — your Twilio number
 *   TWILIO_TO_NUMBER    — the number to call
 */
const CALLEE_IDENTITY = 'callee';
// Twilio reports an unanswered call only through status webhooks, so cap the wait
const ANSWER_TIMEOUT = 45_000;
const TWILIO_API_BASE = 'https://api.twilio.com/2010-04-01';

export class MyAgent extends voice.Agent {
  constructor() {
    super({
      instructions:
        'You are Alex from Acme Dental. You are calling Sam to confirm ' +
        'a dental appointment tomorrow at 10 AM. Keep replies brief. ' +
        'If asked to leave a message, give the appointment details and ' +
        'ask Sam to call the office to confirm. Do not invent a phone number. ' +
        'After leaving a voicemail, wait for any follow-up prompts. ' +
        'Use end_call when the conversation with a human is complete.',
      tools: [
        beta.createEndCallTool({
          // The default also deletes the room; every exit path below already does that.
          deleteRoom: false,
          extraDescription: 'Call after completing the appointment conversation with a human.',
        }),
      ],
    });
  }
}

async function twilioRequest(
  path: string,
  form: Record<string, string>,
): Promise<Record<string, unknown>> {
  const accountSid = process.env.TWILIO_ACCOUNT_SID!;
  const authToken = process.env.TWILIO_AUTH_TOKEN!;
  const response = await fetch(
    `${TWILIO_API_BASE}/Accounts/${encodeURIComponent(accountSid)}${path}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
      },
      body: new URLSearchParams(form),
    },
  );
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(`Twilio request failed (HTTP ${response.status}, code ${body.code})`);
  }
  return body;
}

async function endTwilioCall(callSid: string): Promise<void> {
  const path = `/Calls/${encodeURIComponent(callSid)}.json`;
  try {
    // a ringing call is canceled; an answered one is completed
    await twilioRequest(path, { Status: 'canceled' });
  } catch {
    try {
      await twilioRequest(path, { Status: 'completed' });
    } catch {
      log().warn('failed to end the Twilio call');
    }
  }
}

function escapeXmlAttribute(value: string): string {
  return `"${value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')}"`;
}

export async function entry(ctx: JobContext): Promise<void> {
  const logger = log().child({ room: ctx.room.name });
  const session = new voice.AgentSession({
    stt: new inference.STT({ model: 'deepgram/nova-3', language: 'multi' }),
    llm: new inference.LLM({ model: 'google/gemma-4-31b-it' }),
    tts: new inference.TTS({
      model: 'cartesia/sonic-3',
      voice: '9626c31c-bec5-4cca-baa8-f8ba9e84c8bc',
    }),
    // the callee can speak before the greeting ends; AgentSession skips the AEC warmup
    // for outbound SIP calls on its own but cannot tell an outbound connector call apart
    aecWarmupDuration: null,
  });

  await session.start({
    agent: new MyAgent(),
    room: ctx.room,
    inputOptions: {
      // reduce background voices and noise before audio reaches session STT and AMD STT
      noiseCancellation: BackgroundVoiceCancellation(),
    },
  });

  const twilioCall: { sid?: string } = {};
  ctx.addShutdownCallback(async () => {
    // deleting the room ends the media stream; ending the call also stops a call that is
    // still ringing
    if (twilioCall.sid !== undefined) {
      await endTwilioCall(twilioCall.sid);
    }
    await ctx.deleteRoom();
  });

  // AMD needs a phone call, so console mode is not supported.
  if (!session._roomIO) {
    throw new Error('Cannot access room_io: the AgentSession was not started with a room.');
  }

  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER, TWILIO_TO_NUMBER } =
    process.env;
  if (!(TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_FROM_NUMBER && TWILIO_TO_NUMBER)) {
    logger.error('set the TWILIO_* variables to place the call');
    ctx.shutdown('missing Twilio configuration');
    return;
  }

  const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET } = process.env;
  const connector = new ConnectorClient(LIVEKIT_URL!, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
  const { connectUrl } = await connector.connectTwilioCall({
    twilioCallDirection: ConnectTwilioCallRequest_TwilioCallDirection.OUTBOUND,
    roomName: ctx.room.name!,
    participantIdentity: CALLEE_IDENTITY,
  });
  const twiml = `<Response><Connect><Stream url=${escapeXmlAttribute(connectUrl)}/></Connect></Response>`;
  const call = await twilioRequest('/Calls.json', {
    To: TWILIO_TO_NUMBER,
    From: TWILIO_FROM_NUMBER,
    Twiml: twiml,
  });
  twilioCall.sid = call.sid as string;

  // Unlike a SIP participant, the connector publishes the callee's audio only once the call
  // is answered, and AMD waits only a few seconds for that track. So start AMD after the
  // answer; there is no early media to discard.
  try {
    await waitForTrackPublication({
      room: ctx.room,
      identity: CALLEE_IDENTITY,
      kind: TrackKind.KIND_AUDIO,
      signal: AbortSignal.timeout(ANSWER_TIMEOUT),
    });
  } catch {
    logger.info('call was not answered');
    ctx.shutdown('call not answered');
    return;
  }

  const detector = new voice.AMD(session, { participantIdentity: CALLEE_IDENTITY });
  detector.on('amd_prediction', (event) => {
    logger.info({ 'lk.pii.amd.prediction': event }, 'amd prediction');
  });
  detector.on('amd_menu_observed', (event) => {
    logger.info({ 'lk.pii.amd.menu': event }, 'amd menu (informational)');
  });

  let result: voice.AMDCompletedEvent;
  await detector.start();
  try {
    // TODO: IVR replies press keys with DTMF; verify that the Twilio Connector forwards it
    // (not yet tested with an IVR menu)
    result = await detector.execute();
    logger.info({ 'lk.pii.amd.result': result }, 'amd completed');
  } finally {
    await detector.aclose();
  }

  if (result.isError || result.reason === voice.AMDReason.PARTICIPANT_DISCONNECTED) {
    // the callee hung up, or AMD stopped without detecting the call, such as when
    // end_call closed the session (cancelled)
    ctx.shutdown(result.reason);
  } else if (result.voicemailMessagePlayed && result.category !== voice.AMDCategory.HUMAN) {
    ctx.shutdown('voicemail completed');
  } else if (result.category === voice.AMDCategory.MACHINE_UNAVAILABLE) {
    ctx.shutdown('machine unavailable');
  }
}

export default defineAgent({ entry });

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url) }));
}
