// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type JobContext,
  ServerOptions,
  cli,
  defineAgent,
  inference,
  log,
  voice,
} from '@livekit/agents';
import { TrackKind } from '@livekit/rtc-node';
import { RoomServiceClient, SipClient } from 'livekit-server-sdk';
import { fileURLToPath } from 'node:url';

class MyAgent extends voice.Agent {
  constructor() {
    super({
      instructions:
        'You are reaching out to a customer with a phone call. ' +
        'You are calling to see if they are home. ' +
        'You might encounter an answering machine with a DTMF menu or IVR system. ' +
        'If you do, you will try to leave a message asking them to call back.',
    });
  }
}

/**
 * Telephony AMD example. Mirrors python `examples/telephony/amd.py`.
 *
 * Three SIP env vars control outbound dialing — when all three are set, the
 * agent places a SIP call before running AMD; otherwise it just waits for
 * whoever the SIP gateway routes into the room (inbound).
 *
 *   LIVEKIT_OUTBOUND_TRUNK_ID — outbound trunk (required for outbound)
 *   SIP_PHONE_NUMBER          — number to dial, e.g. "+15551234"
 *   SIP_PARTICIPANT_IDENTITY  — identity to assign the dialed participant
 */
export default defineAgent({
  entry: async (ctx: JobContext) => {
    const logger = log().child({ room: ctx.room.name });

    const session = new voice.AgentSession({
      stt: new inference.STT({
        model: 'deepgram/nova-3',
        language: 'multi',
      }),
      llm: new inference.LLM({ model: 'openai/gpt-4.1-mini' }),
      tts: new inference.TTS({
        model: 'cartesia/sonic-3',
        voice: '9626c31c-bec5-4cca-baa8-f8ba9e84c8bc',
      }),
      preemptiveGeneration: true,
    });

    await session.start({
      agent: new MyAgent(),
      room: ctx.room,
    });

    const phoneNumber = process.env.SIP_PHONE_NUMBER;
    const participantIdentity = process.env.SIP_PARTICIPANT_IDENTITY;
    const outboundTrunkId = process.env.LIVEKIT_OUTBOUND_TRUNK_ID;

    // Focus the session on the callee before AMD starts so audio recognition
    // doesn't push frames from any pre-existing participant into AMD's
    // pipeline. Mirrors python's `session.room_io.set_participant`.
    if (!session._roomIO) {
      throw new Error(
        'session room_io is unavailable. Make sure you use `dev` or `start` commands',
      );
    }
    if (participantIdentity) {
      session._roomIO.setParticipant(participantIdentity);
    }

    const detector = new voice.AMD(session, {
      participantIdentity,
    });

    try {
      // Start running AMD before creating the SIP participant to avoid losing
      // any of the early audio. Same ordering as the python example.
      if (phoneNumber && outboundTrunkId && participantIdentity) {
        if (
          !process.env.LIVEKIT_URL ||
          !process.env.LIVEKIT_API_KEY ||
          !process.env.LIVEKIT_API_SECRET
        ) {
          throw new Error('outbound dial requires LIVEKIT_URL/API_KEY/API_SECRET');
        }
        const roomName = ctx.room.name;
        if (!roomName) {
          throw new Error('ctx.room has no name; cannot place outbound call');
        }

        const sip = new SipClient(
          process.env.LIVEKIT_URL,
          process.env.LIVEKIT_API_KEY,
          process.env.LIVEKIT_API_SECRET,
        );

        logger.info({ participantIdentity }, 'creating SIP participant');
        await sip.createSipParticipant(outboundTrunkId, phoneNumber, roomName, {
          participantIdentity,
          waitUntilAnswered: true,
        });

        const participant = await ctx.waitForParticipant(participantIdentity);
        const subscribedAudioTrackSids: string[] = [];
        for (const pub of participant.trackPublications.values()) {
          if (pub.subscribed && pub.kind === TrackKind.KIND_AUDIO && pub.sid) {
            subscribedAudioTrackSids.push(pub.sid);
          }
        }
        logger.info(
          {
            actualIdentity: participant.identity,
            expectedIdentity: participantIdentity,
            kind: participant.kind,
            audioTracksSubscribed: subscribedAudioTrackSids,
          },
          'participant joined',
        );
      }

      const result = await detector.execute();

      if (
        result.category === voice.AMDCategory.HUMAN ||
        result.category === voice.AMDCategory.UNCERTAIN
      ) {
        logger.info(
          { amd: result },
          'human answered the call or amd is uncertain, proceeding with normal conversation',
        );
      } else if (result.category === voice.AMDCategory.MACHINE_IVR) {
        logger.info({ amd: result }, 'ivr menu detected, starting navigation');
      } else if (result.category === voice.AMDCategory.MACHINE_VM) {
        logger.info({ amd: result }, 'voicemail detected, leaving a message');
        const speechHandle = session.generateReply({
          instructions:
            "You've reached voicemail. Leave a brief message asking the customer to call back.",
        });
        await speechHandle.waitForPlayout();
        session.shutdown({ reason: 'amd:machine-vm' });
      } else if (result.category === voice.AMDCategory.MACHINE_UNAVAILABLE) {
        logger.info({ amd: result }, 'mailbox unavailable, ending call');
        session.shutdown({ reason: 'amd:machine-unavailable' });
      } else {
        logger.info({ amd: result }, 'answering machine detection was uncertain');
      }
    } finally {
      await detector.aclose();
    }

    // Hang up the SIP call by deleting the room when the agent shuts down.
    // Mirrors python's `add_shutdown_callback(hangup)` pattern.
    ctx.addShutdownCallback(async () => {
      const roomName = ctx.room.name;
      if (
        !roomName ||
        !process.env.LIVEKIT_URL ||
        !process.env.LIVEKIT_API_KEY ||
        !process.env.LIVEKIT_API_SECRET
      ) {
        return;
      }
      const rooms = new RoomServiceClient(
        process.env.LIVEKIT_URL,
        process.env.LIVEKIT_API_KEY,
        process.env.LIVEKIT_API_SECRET,
      );
      try {
        await rooms.deleteRoom(roomName);
      } catch (err) {
        logger.warn({ 'lk.pii.error': err }, 'failed to delete room during hangup');
      }
    });
  },
});

cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url) }));
