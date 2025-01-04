// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type JobContext,
  type JobProcess,
  WorkerOptions,
  cli,
  defineAgent,
  llm,
  pipeline,
} from '@livekit/agents';
import * as deepgram from '@livekit/agents-plugin-deepgram';
import * as elevenlabs from '@livekit/agents-plugin-elevenlabs';
import * as openai from '@livekit/agents-plugin-openai';
import * as silero from '@livekit/agents-plugin-silero';
import { SipClient } from 'livekit-server-sdk';
import { fileURLToPath } from 'node:url';

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load();
  },
  entry: async (ctx: JobContext) => {
    const vad = ctx.proc.userData.vad! as silero.VAD;

    await ctx.connect();

    const sipClient = new SipClient(
      process.env.LIVEKIT_URL ?? '',
      process.env.LIVEKIT_API_KEY,
      process.env.LIVEKIT_API_SECRET,
    );

    const trunkId = '...'; // create this with the CLI: https://docs.livekit.io/agents/quickstarts/outbound-calls/
    const phoneNumber = '...'; // read this from the metadata or hardcode it - e.g.: 'tel:+43.....'
    const roomName = ctx.room.name ?? '';
    const participantIdentity = 'Example participant identity';

    const sipParticipantOptions = {
      participantIdentity,
      participantName: 'Example participant name',
    };

    console.log('came here');
    await sipClient.createSipParticipant(trunkId, phoneNumber, roomName, sipParticipantOptions);

    const participant = await ctx.waitForParticipant(participantIdentity);

    const initialContext = new llm.ChatContext().append({
      role: llm.ChatRole.SYSTEM,
      text: 'You are a helpful assistant.',
    });

    const agent = new pipeline.VoicePipelineAgent(
      vad,
      new deepgram.STT(),
      new openai.LLM(),
      new elevenlabs.TTS(),
      {
        chatCtx: initialContext,
      },
    );

    agent.start(ctx.room, participant);

    await agent.say('Hello - how can I help?', true);
  },
});

cli.runApp(new WorkerOptions({ agent: fileURLToPath(import.meta.url) }));
