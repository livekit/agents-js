// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type JobContext,
  type JobProcess,
  WorkerOptions,
  cli,
  defineAgent,
  llm,
  voice,
} from '@livekit/agents';
import * as google from '@livekit/agents-plugin-google';
import * as silero from '@livekit/agents-plugin-silero';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

// Shared data that's used by the storyteller agent.
// This structure is passed as a parameter to function calls.
type StoryData = {
  name?: string;
  location?: string;
};

const roomNameSchema = z.enum(['bedroom', 'living room', 'kitchen', 'bathroom', 'office']);

const getWeather = llm.tool({
  description: ' Called when the user asks about the weather.',
  parameters: z.object({
    location: z.string().describe('The location to get the weather for'),
  }),
  execute: async ({ location }) => {
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

// Use inheritance to create agent with custom hooks
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
      instructions: `You are a storyteller. Use the user's information in order to make the story personalized.
          The user's name is ${name}, from ${location}`,
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

cli.runApp(new WorkerOptions({ agent: fileURLToPath(import.meta.url) }));
