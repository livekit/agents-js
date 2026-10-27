// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type JobContext,
  type ModelSettings,
  ServerOptions,
  beta,
  cli,
  defineAgent,
  inference,
  llm,
  log,
  voice,
} from '@livekit/agents';
import { BackgroundVoiceCancellation } from '@livekit/noise-cancellation-node';
import { RoomServiceClient, SipClient } from 'livekit-server-sdk';
import { fileURLToPath } from 'node:url';

/**
 * Multi-turn answering-machine detection (AMD) on an outbound call. Mirrors python
 * `examples/telephony/amd.py`; see `telephony_amd.md` for how AMD works.
 *
 * To place an outbound call, set all three:
 *
 *   SIP_PHONE_NUMBER          — number to dial, e.g. "+15551234"
 *   SIP_PARTICIPANT_IDENTITY  — identity to assign the dialed participant
 *   SIP_OUTBOUND_TRUNK_ID     — outbound trunk
 */
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
          deleteRoom: false, // The job shutdown callback deletes the room.
          extraDescription: 'Call after completing the appointment conversation with a human.',
        }),
      ],
    });
  }

  override async llmNode(
    chatCtx: llm.ChatContext,
    toolCtx: llm.ToolContext,
    modelSettings: ModelSettings,
  ) {
    if (this.session.amd !== null) {
      toolCtx = new llm.ToolContext(toolCtx.tools.filter((tool) => tool.id !== 'end_call'));
    }
    return voice.Agent.default.llmNode(this, chatCtx, toolCtx, modelSettings);
  }
}

export async function entry(ctx: JobContext): Promise<void> {
  const logger = log().child({ room: ctx.room.name });
  const session = new voice.AgentSession({
    stt: new inference.STT({ model: 'deepgram/nova-3', language: 'multi' }),
    llm: new inference.LLM({ model: 'openai/gpt-4.1-mini' }),
    tts: new inference.TTS({
      model: 'cartesia/sonic-3',
      voice: '9626c31c-bec5-4cca-baa8-f8ba9e84c8bc',
    }),
  });

  await session.start({
    agent: new MyAgent(),
    room: ctx.room,
    inputOptions: {
      // reduce background voices and noise before audio reaches session STT and AMD STT
      noiseCancellation: BackgroundVoiceCancellation(),
    },
  });

  ctx.addShutdownCallback(async () => {
    const roomName = ctx.room.name;
    const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET } = process.env;
    if (!roomName || !LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
      return;
    }
    // deleting the room disconnects the SIP participant
    await new RoomServiceClient(LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET).deleteRoom(
      roomName,
    );
  });

  const phoneNumber = process.env.SIP_PHONE_NUMBER;
  const participantIdentity = process.env.SIP_PARTICIPANT_IDENTITY || undefined;
  const outboundTrunkId = process.env.SIP_OUTBOUND_TRUNK_ID;

  // AMD needs a SIP participant, so console mode is not supported.
  if (!session._roomIO) {
    throw new Error('Cannot access room_io: the AgentSession was not started with a room.');
  }

  const detector = new voice.AMD(session, {
    participantIdentity,
    voicemailIdleTimeout: 10_000,
  });
  detector.on('amd_prediction', (event) => {
    logger.info({ 'lk.pii.amd.prediction': event }, 'amd prediction');
  });
  detector.on('amd_menu_observed', (event) => {
    logger.info({ 'lk.pii.amd.menu': event }, 'amd menu (informational)');
  });

  let result: voice.AMDCompletedEvent;
  await detector.start();
  try {
    // Start AMD before creating the SIP participant.
    if (ctx.room.isConnected && phoneNumber && outboundTrunkId && participantIdentity) {
      const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET } = process.env;
      const sip = new SipClient(LIVEKIT_URL!, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
      try {
        await sip.createSipParticipant(outboundTrunkId, phoneNumber, ctx.room.name!, {
          participantIdentity,
          waitUntilAnswered: true,
          timeout: 45,
        });
      } catch {
        logger.info('sip call was not answered');
        ctx.shutdown('call not answered');
        return;
      }
      // The call may end just before waitUntilAnswered returns.
      if (!ctx.room.remoteParticipants.has(participantIdentity)) {
        logger.info('sip participant missing, ending');
        ctx.shutdown('participant missing');
        return;
      }
    }

    result = await detector.execute();
    logger.info({ 'lk.pii.amd.result': result }, 'amd completed');
  } finally {
    await detector.aclose();
  }

  if (result.voicemailMessagePlayed && result.category !== voice.AMDCategory.HUMAN) {
    ctx.shutdown('voicemail completed');
  }
}

export default defineAgent({ entry });

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url) }));
}
