// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type JobContext,
  type JobProcess,
  ServerOptions,
  cli,
  defineAgent,
  inference,
  log,
  voice,
} from '@livekit/agents';
import * as livekit from '@livekit/agents-plugin-livekit';
import * as silero from '@livekit/agents-plugin-silero';
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

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load();
  },
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
      turnHandling: {
        turnDetection: new livekit.turnDetector.MultilingualModel(),
      },
      vad: ctx.proc.userData.vad! as silero.VAD,
      preemptiveGeneration: true,
    });

    await session.start({
      agent: new MyAgent(),
      room: ctx.room,
    });

    const detector = new voice.AMD(session, {
      llm: new inference.LLM({ model: 'openai/gpt-5-mini' }),
    });

    const result = await detector.execute();

    if (result.category === voice.AMDCategory.HUMAN) {
      logger.info({ amd: result }, 'human answered the call, proceeding with normal conversation');
      return;
    }

    if (result.category === voice.AMDCategory.MACHINE_IVR) {
      logger.info({ amd: result }, 'ivr menu detected, starting navigation');
      return;
    }

    if (result.category === voice.AMDCategory.MACHINE_VM) {
      logger.info({ amd: result }, 'voicemail detected, leaving a message');
      const speechHandle = session.generateReply({
        instructions:
          "You've reached voicemail. Leave a brief message asking the customer to call back.",
      });
      await speechHandle.waitForPlayout();
      session.shutdown({ reason: 'amd:machine-vm' });
      return;
    }

    if (result.category === voice.AMDCategory.MACHINE_UNAVAILABLE) {
      logger.info({ amd: result }, 'mailbox unavailable, ending call');
      session.shutdown({ reason: 'amd:machine-unavailable' });
      return;
    }

    logger.info({ amd: result }, 'answering machine detection was uncertain');
  },
});

cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url) }));
