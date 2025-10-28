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
import * as livekit from '@livekit/agents-plugin-livekit';
import * as silero from '@livekit/agents-plugin-silero';
import { BackgroundVoiceCancellation } from '@livekit/noise-cancellation-node';
import { fileURLToPath } from 'node:url';

const customTextInputHandler = (session: voice.AgentSession, event: voice.TextInputEvent): void => {
  const message = event.text;

  if (message.startsWith('/')) {
    if (message === '/help') {
      session.say('Available commands: /help, /status');
      return;
    }
    if (message === '/status') {
      session.say('Agent is running normally');
      return;
    }
  }

  if (['spam', 'inappropriate'].some((word) => message.toLowerCase().includes(word))) {
    session.say("I can't respond to that type of message.");
    return;
  }

  session.interrupt();
  session.generateReply({ userInput: message });
};

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load();
  },
  entry: async (ctx: JobContext) => {
    const agent = new voice.Agent({
      instructions:
        "You are a helpful assistant, you can hear the user's message and respond to it.",
    });

    const vad = ctx.proc.userData.vad! as silero.VAD;

    const session = new voice.AgentSession({
      vad,
      stt: 'cartesia/ink-whisper:en',
      llm: 'openai/gpt-4.1-mini',
      tts: 'cartesia/sonic-2:794f9389-aac1-45b6-b726-9d9369183238',
      turnDetection: new livekit.turnDetector.MultilingualModel(),
    });

    await session.start({
      agent,
      room: ctx.room,
      inputOptions: {
        noiseCancellation: BackgroundVoiceCancellation(),
        textInputCallback: customTextInputHandler,
      },
    });

    session.say('Hello, how can I help you today?');
  },
});

cli.runApp(new WorkerOptions({ agent: fileURLToPath(import.meta.url) }));
