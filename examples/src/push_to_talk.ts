// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type JobContext,
  type JobProcess,
  WorkerOptions,
  cli,
  defineAgent,
  inference,
  initializeLogger,
  voice,
} from '@livekit/agents';
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
    initializeLogger({ pretty: true });

    const session = new voice.AgentSession({
      vad: ctx.proc.userData.vad! as silero.VAD,
      stt: new inference.STT({ model: 'deepgram/nova-3', language: 'en' }),
      llm: new inference.LLM({ model: 'openai/gpt-4.1-mini' }),
      tts: new inference.TTS({
        model: 'cartesia/sonic-3',
        voice: '9626c31c-bec5-4cca-baa8-f8ba9e84c8bc',
      }),
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
