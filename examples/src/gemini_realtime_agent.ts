// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type JobContext,
  type JobProcess,
  ServerOptions,
  cli,
  dedent,
  defineAgent,
  llm,
  voice,
} from '@livekit/agents';
import * as google from '@livekit/agents-plugin-google';
import * as silero from '@livekit/agents-plugin-silero';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Test scenarios for the new `toolBehavior` / `toolResponseScheduling` feature.
// Switch `toolBehavior` and `toolResponseScheduling` below before launching, e.g.:
//   pnpm build && node ./examples/src/gemini_realtime_agent.ts dev --log-level=debug
//
// Supported values:
//   toolBehavior           : undefined | BLOCKING | NON_BLOCKING
//   toolResponseScheduling : undefined | SILENT | WHEN_IDLE | INTERRUPT
//   GET_WEATHER_DELAY_MS : delay before getWeather returns (default 4000)
// ---------------------------------------------------------------------------
const GET_WEATHER_DELAY_MS = Number(process.env.GET_WEATHER_DELAY_MS ?? 4000);

const toolBehavior: google.beta.realtime.Behavior | undefined =
  google.beta.realtime.Behavior.NON_BLOCKING;
const toolResponseScheduling: google.beta.realtime.FunctionResponseScheduling | undefined =
  google.beta.realtime.FunctionResponseScheduling.WHEN_IDLE;

console.log(
  `[gemini_realtime_agent] toolBehavior=${toolBehavior ?? 'unset'} ` +
    `toolResponseScheduling=${toolResponseScheduling ?? 'unset'} ` +
    `getWeatherDelayMs=${GET_WEATHER_DELAY_MS}`,
);

type StoryData = {
  name?: string;
  location?: string;
};

const roomNameSchema = z.enum(['bedroom', 'living room', 'kitchen', 'bathroom', 'office']);

const getWeather = llm.tool({
  description: 'Called when the user asks about the weather.',
  parameters: z.object({
    location: z.string().describe('The location to get the weather for'),
  }),
  // Deliberately slow so BLOCKING vs NON_BLOCKING is visible.
  execute: async ({ location }) => {
    await new Promise((resolve) => setTimeout(resolve, GET_WEATHER_DELAY_MS));
    return `The weather in ${location} is sunny today.`;
  },
});

const toggleLight = llm.tool({
  description: 'Called when the user asks to turn on or off the light.',
  parameters: z.object({
    room: roomNameSchema.describe('The room to turn the light in'),
    switchTo: z.enum(['on', 'off']).describe('The state to turn the light to'),
  }),
  execute: async ({ room, switchTo }) => {
    return `The light in the ${room} is now ${switchTo}.`;
  },
});

class IntroAgent extends voice.Agent<StoryData> {
  async onEnter() {
    this.session.generateReply({
      instructions: '"greet the user and gather information"',
    });
  }

  static create() {
    return new IntroAgent({
      instructions: `You are a story teller. Your goal is to gather a few pieces of information from the user to make the story personalized and engaging. Ask the user for their name and where they are from.`,
      tools: {
        informationGathered: llm.tool({
          description:
            'Called when the user has provided the information needed to make the story personalized and engaging.',
          parameters: z.object({
            name: z.string().describe('The name of the user'),
            location: z.string().describe('The location of the user'),
          }),
          execute: async ({ name, location }, { ctx }) => {
            ctx.userData.name = name;
            ctx.userData.location = location;

            const storyAgent = StoryAgent.create(name, location);
            return llm.handoff({ agent: storyAgent, returns: "Let's start the story!" });
          },
        }),
        getWeather,
        toggleLight,
      },
    });
  }
}

class StoryAgent extends voice.Agent<StoryData> {
  async onEnter() {
    this.session.generateReply();
  }

  static create(name: string, location: string) {
    return new StoryAgent({
      instructions: dedent`
        You are a storyteller. Use the user's information in order to make the story personalized.
        The user's name is ${name}, from ${location}
      `,
    });
  }
}

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load();
  },
  entry: async (ctx: JobContext) => {
    const userdata: StoryData = {};

    const session = new voice.AgentSession({
      vad: ctx.proc.userData.vad! as silero.VAD,
      llm: new google.beta.realtime.RealtimeModel({
        thinkingConfig: {
          // Making the thoughts false to speed up the realtime response
          // If you want to keep the thoughts, set includeThoughts to true or leave it undefined
          includeThoughts: false,
        },
        toolBehavior,
        toolResponseScheduling,
      }),
      userData: userdata,
    });

    await session.start({
      agent: IntroAgent.create(),
      room: ctx.room,
    });

    const participant = await ctx.waitForParticipant();
    console.log('participant joined: ', participant.identity);
  },
});

cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url) }));
