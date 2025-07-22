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
import * as livekit from '@livekit/agents-plugin-livekit';
import * as openai from '@livekit/agents-plugin-openai';
import * as silero from '@livekit/agents-plugin-silero';
import { fileURLToPath } from 'node:url';

/**
 * This example demonstrates how to use LiveKit's turn detection model with a realtime LLM.
 * Since the current turn detection model runs in text space, it will need to be combined
 * with a STT model, even though the audio is going directly to the Realtime API.
 * In this example, speech is being processed in parallel by both the STT and the realtime API
 */
export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load();
  },
  entry: async (ctx: JobContext) => {
    await ctx.connect();

    const agent = new voice.Agent({
      instructions: 'You are a helpful assistant.',
    });

    const session = new voice.AgentSession({
      turnDetection: new livekit.turnDetector.EnglishModel(),
      vad: ctx.proc.userData.vad! as silero.VAD,
      stt: new deepgram.STT(),
      // To use OpenAI Realtime API
      llm: new openai.LLM(),
      // llm: new openai.realtime.RealtimeModel({
      //   voice: 'alloy',
      //   // it's necessary to turn off turn detection in the OpenAI Realtime API in order to use
      //   // LiveKit's turn detection model
      //   turnDetection: null,
      //   inputAudioTranscription: null, // we use Deepgram STT instead
      // }),
    });

    await session.start({ agent, room: ctx.room });
  },
});

cli.runApp(new WorkerOptions({ agent: fileURLToPath(import.meta.url) }));
