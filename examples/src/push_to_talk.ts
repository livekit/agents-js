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
import type { ChatContext, ChatMessage } from 'agents/dist/llm/chat_context.js';
import { fileURLToPath } from 'node:url';

class MyAgent extends voice.Agent {
  async onUserTurnCompleted(chatCtx: ChatContext, newMessage: ChatMessage) {
    if (!newMessage.textContent || newMessage.textContent.length === 0) {
      console.log('ignore empty user turn');
      throw new voice.StopResponse();
    }
  }
}

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load();
  },
  entry: async (ctx: JobContext) => {
    const session = new voice.AgentSession({
      vad: ctx.proc.userData.vad! as silero.VAD,
      stt: new deepgram.STT(),
      llm: new openai.LLM(),
      tts: new elevenlabs.TTS(),
      turnDetection: 'manual',
    });

    const agent = new MyAgent({
      instructions:
        "You are a helpful assistant, you can hear the user's message and respond to it.",
    });

    await session.start({
      agent,
      room: ctx.room,
    });

    ctx.room.localParticipant?.registerRpcMethod('start_turn', async () => {
      session.interrupt();
      session.clearUserTurn();
      return 'ok';
    });

    ctx.room.localParticipant?.registerRpcMethod('end_turn', async () => {
      session.commitUserTurn();
      return 'ok';
    });

    ctx.room.localParticipant?.registerRpcMethod('cancel_turn', async () => {
      session.clearUserTurn();
      return 'ok';
    });
  },
});

cli.runApp(new WorkerOptions({ agent: fileURLToPath(import.meta.url) }));
