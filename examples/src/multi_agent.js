// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { WorkerOptions, cli, defineAgent, llm, voice, } from '@livekit/agents';
import * as deepgram from '@livekit/agents-plugin-deepgram';
import * as elevenlabs from '@livekit/agents-plugin-elevenlabs';
import * as livekit from '@livekit/agents-plugin-livekit';
import * as openai from '@livekit/agents-plugin-openai';
import * as silero from '@livekit/agents-plugin-silero';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
// Use inheritance to create agent with custom hooks
class IntroAgent extends voice.Agent {
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
                    description: 'Called when the user has provided the information needed to make the story personalized and engaging.',
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
            },
        });
    }
}
class StoryAgent extends voice.Agent {
    async onEnter() {
        this.session.generateReply();
    }
    static create(name, location) {
        return new StoryAgent({
            instructions: `You are a storyteller. Use the user's information in order to make the story personalized.
        The user's name is ${name}, from ${location}`,
        });
    }
}
export default defineAgent({
    prewarm: async (proc) => {
        proc.userData.vad = await silero.VAD.load();
    },
    entry: async (ctx) => {
        const userdata = {};
        const session = new voice.AgentSession({
            vad: ctx.proc.userData.vad,
            stt: new deepgram.STT(),
            tts: new elevenlabs.TTS(),
            llm: new openai.LLM(),
            // to use realtime model, replace the stt, llm, tts and vad with the following
            // llm: new openai.realtime.RealtimeModel(),
            userData: userdata,
            turnDetection: new livekit.turnDetector.EnglishModel(),
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
//# sourceMappingURL=multi_agent.js.map