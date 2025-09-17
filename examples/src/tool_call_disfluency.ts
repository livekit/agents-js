// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  AutoSubscribe,
  type JobContext,
  type JobProcess,
  WorkerOptions,
  cli,
  defineAgent,
  llm,
  voice,
} from '@livekit/agents';
import * as deepgram from '@livekit/agents-plugin-deepgram';
import * as elevenlabs from '@livekit/agents-plugin-elevenlabs';
import * as livekit from '@livekit/agents-plugin-livekit';
import * as openai from '@livekit/agents-plugin-openai';
import * as silero from '@livekit/agents-plugin-silero';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

class VoiceAgent extends voice.Agent {
  constructor(options: voice.AgentOptions<unknown>) {
    super(options);
  }

  async onEnter(): Promise<void> {
    const handle = this.session.say('I can look up the weather for you.');
    await handle.waitForPlayout();
  }
}

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load();
  },
  entry: async (ctx: JobContext) => {
    await ctx.connect(undefined, AutoSubscribe.AUDIO_ONLY, undefined);
    await ctx.waitForParticipant();
    const vad = ctx.proc.userData.vad! as silero.VAD;

    const getWeather = llm.tool({
      description: ' Called when the user asks about the weather.',
      parameters: z.object({
        location: z.string().describe('The location to get the weather for'),
      }),
      execute: async ({ location }, { ctx }) => {
        ctx.session.say('Let me look up the weather for you.');
        await ctx.waitForPlayout();

        return `The weather in ${location} is sunny today.`;
      },
    });

    const agent = new VoiceAgent({
      instructions:
        "You are a helpful assistant, you can hear the user's message and respond to it.",
      tools: {
        getWeather,
      },
    });

    const session = new voice.AgentSession({
      vad,
      stt: new deepgram.STT(),
      llm: new openai.LLM(),
      tts: new elevenlabs.TTS(),
      turnDetection: new livekit.turnDetector.MultilingualModel(),
    });

    await session.start({
      agent,
      room: ctx.room,
    });
  },
});

cli.runApp(new WorkerOptions({ agent: fileURLToPath(import.meta.url) }));
