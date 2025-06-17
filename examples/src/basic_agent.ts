// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type JobContext,
  type JobProcess,
  WorkerOptions,
  cli,
  defineAgent,
  voice,
} from '@livekit/agents';
import * as deepgram from '@livekit/agents-plugin-deepgram';
import * as elevenlabs from '@livekit/agents-plugin-elevenlabs';
import * as openai from '@livekit/agents-plugin-openai';
import * as silero from '@livekit/agents-plugin-silero';
import { fileURLToPath } from 'node:url';

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load();
  },
  entry: async (ctx: JobContext) => {
    const agent = new voice.Agent({
      instructions:
        "You are a helpful assistant, you can hear the user's message and respond to it.",
    });
    await ctx.connect();
    const participant = await ctx.waitForParticipant();
    console.log('participant joined: ', participant.identity);

    const vad = ctx.proc.userData.vad! as silero.VAD;

    const session = new voice.AgentSession(
      vad,
      new deepgram.STT(),
      new openai.LLM(),
      new elevenlabs.TTS(),
    );
    session.start(agent, ctx.room);
  },
});

cli.runApp(new WorkerOptions({ agent: fileURLToPath(import.meta.url) }));
