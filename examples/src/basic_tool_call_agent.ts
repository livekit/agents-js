// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type JobContext,
  type JobProcess,
  ServerOptions,
  cli,
  defineAgent,
  llm,
  voice,
} from '@livekit/agents';
import * as livekit from '@livekit/agents-plugin-livekit';
import * as silero from '@livekit/agents-plugin-silero';
import { BackgroundVoiceCancellation } from '@livekit/noise-cancellation-node';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const roomNameSchema = z.enum(['bedroom', 'living room', 'kitchen', 'bathroom', 'office']);

type UserData = {
  number: number;
};

class RouterAgent extends voice.Agent<UserData> {
  async onEnter(): Promise<void> {
    this.session.say("Hello, I'm a router agent. I can help you with your tasks.");
  }
}

class GameAgent extends voice.Agent<UserData> {
  async onEnter(): Promise<void> {
    this.session.generateReply({
      userInput: 'Ask the user for a number, then check the stored number',
      toolChoice: 'none',
    });
  }
}

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load();
  },
  entry: async (ctx: JobContext) => {
    const getWeather = llm.tool({
      description: ' Called when the user asks about the weather.',
      parameters: z.object({
        location: z.string().describe('The location to get the weather for'),
      }),
      execute: async ({ location }, { ctx }) => {
        ctx.session.say('Checking the weather, please wait a moment haha...');
        return `The weather in ${location} is sunny today.`;
      },
    });

    const toggleLight = llm.tool({
      description: 'Called when the user asks to turn on or off the light.',
      parameters: z.object({
        room: roomNameSchema.describe('The room to turn the light in'),
        switchTo: z.enum(['on', 'off']).describe('The state to turn the light to'),
      }),
      execute: async ({ room, switchTo }, { ctx }) => {
        ctx.session.generateReply({
          userInput: 'Tell user wait a moment for about 10 seconds',
        });

        return `The light in the ${room} is now ${switchTo}.`;
      },
    });

    const getNumber = llm.tool({
      description:
        'Called when the user wants to get a number value, None if user want a random value',
      parameters: z.object({
        value: z
          .number()
          .nullable() // .optional() is not supported in strict mode
          .describe('The number value, do not pass this parameter if you want a random value'),
      }),
      execute: async ({ value }) => {
        if (value === undefined || value === null) {
          value = Math.floor(Math.random() * 100);
        }
        return `The number value is ${value}.`;
      },
    });

    const checkStoredNumber = llm.tool({
      description: 'Called when the user wants to check the stored number.',
      execute: async (_, { ctx }: llm.ToolOptions<UserData>) => {
        return `The stored number is ${ctx.userData.number}.`;
      },
    });

    const updateStoredNumber = llm.tool({
      description: 'Called when the user wants to update the stored number.',
      parameters: z.object({
        number: z.number().describe('The number to update the stored number to'),
      }),
      execute: async ({ number }, { ctx }: llm.ToolOptions<UserData>) => {
        ctx.userData.number = number;
        return `The stored number is now ${number}.`;
      },
    });

    const routerAgent = new RouterAgent({
      instructions: 'You are a helpful assistant.',
      tools: {
        getWeather,
        toggleLight,
        playGame: llm.tool({
          description: 'Called when the user wants to play a game (transfer user to a game agent).',
          execute: async (): Promise<llm.AgentHandoff> => {
            return llm.handoff({ agent: gameAgent, returns: 'The game is now playing.' });
          },
        }),
      },
    });

    const gameAgent = new GameAgent({
      instructions: 'You are a game agent. You are playing a game with the user.',
      tools: {
        getNumber,
        checkStoredNumber,
        updateStoredNumber,
        finishGame: llm.tool({
          description: 'Called when the user wants to finish the game.',
          execute: async () => {
            return llm.handoff({ agent: routerAgent, returns: 'The game is now finished.' });
          },
        }),
      },
    });

    const vad = ctx.proc.userData.vad! as silero.VAD;

    const session = new voice.AgentSession({
      vad,
      stt: 'assemblyai/universal-streaming:en',
      llm: 'google/gemini-3-flash-preview',
      tts: 'cartesia/sonic-2:9626c31c-bec5-4cca-baa8-f8ba9e84c8bc',
      turnDetection: new livekit.turnDetector.MultilingualModel(),
      userData: { number: 0 },
      voiceOptions: {
        preemptiveGeneration: true,
      },
    });

    await session.start({
      agent: routerAgent,
      room: ctx.room,
      inputOptions: {
        noiseCancellation: BackgroundVoiceCancellation(),
      },
    });
  },
});

cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url) }));
