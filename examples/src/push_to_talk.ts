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

    const session = new voice.AgentSession({
      vad,
      stt: new deepgram.STT(),
      llm: new openai.LLM(),
      tts: new elevenlabs.TTS(),
    });

    if (!ctx.room.localParticipant) {
      throw new Error('Local participant not found');
    }

    const startTurn = (callerIdentity: string) => {
      // session.interrupt();
      session.clearUserTurn();
      // session.input.setAudioEnabled(true);
      console.log('start turn', callerIdentity);
    };

    const endTurn = (callerIdentity: string) => {
      // session.input.setAudioEnabled(false);
      session.commitUserTurn();
      console.log('end turn', callerIdentity);
    };

    const cancelTurn = (callerIdentity: string) => {
      // session.input.setAudioEnabled(false);
      session.clearUserTurn();
      console.log('cancel turn', callerIdentity);
    };

    ctx.room.localParticipant.registerRpcMethod(
      'turn-toggle',
      async ({ callerIdentity, payload }) => {
        if (payload !== 'start' && payload !== 'end' && payload !== 'cancel') {
          throw new Error('Invalid payload');
        }

        if (payload === 'start') {
          startTurn(callerIdentity);
        } else if (payload === 'end') {
          endTurn(callerIdentity);
        } else if (payload === 'cancel') {
          cancelTurn(callerIdentity);
        }

        return 'ok';
      },
    );

    session.start(agent, ctx.room);
  },
});

cli.runApp(new WorkerOptions({ agent: fileURLToPath(import.meta.url) }));
