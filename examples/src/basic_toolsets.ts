// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type JobContext,
  type JobProcess,
  ServerOptions,
  cli,
  defineAgent,
  inference,
  llm,
  voice,
} from '@livekit/agents';
import * as livekit from '@livekit/agents-plugin-livekit';
import * as silero from '@livekit/agents-plugin-silero';
import { BackgroundVoiceCancellation } from '@livekit/noise-cancellation-node';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

class InfoTask extends voice.AgentTask<string> {
  private key: string;

  constructor(key: string, sharedToolset: llm.Toolset) {
    super({
      instructions: `Collect the user's ${key}. Once you have it, call saveUserInfo IMMEDIATELY. No chitchat.`,
      tools: [
        sharedToolset,
        llm.tool({
          name: 'saveUserInfo',
          description: `Save the user's ${key} to the database`,
          parameters: z.object({
            [key]: z.string(),
          }),
          execute: async (args) => {
            this.complete(args[key] as string);
            return `Thanks, collected ${key} successfully: ${args[key]}`;
          },
        }),
      ],
    });
    this.key = key;
  }

  async onEnter() {
    this.session.generateReply({ userInput: `Ask the user for their ${this.key}` });
  }
}

function makeWeatherAgent(returnHome: () => voice.Agent) {
  const weatherToolset = new llm.Toolset({
    id: 'weather_tools',
    tools: [
      llm.tool({
        name: 'getWeather',
        description: 'Get the weather for a given location',
        parameters: z.object({ location: z.string() }),
        execute: async ({ location }) => `The weather in ${location} is sunny today.`,
      }),
    ],
  });

  return new voice.Agent({
    instructions: 'You are a weather agent. Provide weather information then hand back when done.',
    tools: [
      weatherToolset,
      llm.tool({
        name: 'finishWeatherConversation',
        description: 'Call this when you want to finish the weather conversation',
        execute: async () => {
          return llm.handoff({ agent: returnHome(), returns: 'Transfer back to main agent.' });
        },
      }),
    ],
  });
}

class MainAgent extends voice.Agent {
  private locationToolset: llm.Toolset;

  constructor(locationToolset: llm.Toolset) {
    super({
      instructions:
        'You are a helpful assistant. Use the location toolset for weather/timezone. Use transferToWeather when the user asks about weather. Use swapToolset / reapplyTools to exercise updateTools.',
      tools: [
        locationToolset,
        llm.tool({
          name: 'transferToWeather',
          description: 'Call this when the user wants to know the weather',
          execute: async () => {
            return llm.handoff({
              agent: makeWeatherAgent(() => new MainAgent(locationToolset)),
              returns: "Let's switch to the weather agent.",
            });
          },
        }),
        llm.tool({
          name: 'swapToolset',
          description: 'Replace the active toolset with a brand-new toolset (tests updateTools).',
          execute: async () => {
            const replacement = new llm.Toolset({
              id: 'location_tools_v2',
              tools: [
                llm.tool({
                  name: 'getWeather',
                  description: 'v2 weather',
                  parameters: z.object({ location: z.string() }),
                  execute: async ({ location }) => `v2: ${location} -> sunny`,
                }),
              ],
            });
            await this.updateTools([replacement]);
            return 'Swapped toolset.';
          },
        }),
        llm.tool({
          name: 'reapplyTools',
          description: 'Re-apply the current tool list unchanged (idempotent updateTools).',
          execute: async () => {
            await this.updateTools([...this.toolCtx.tools]);
            return 'Re-applied the same tool list.';
          },
        }),
      ],
    });
    this.locationToolset = locationToolset;
  }

  async onEnter() {
    const name = await new InfoTask('name', this.locationToolset).run();
    await this.session.say(
      `Got it, ${name}. Ask me about weather, or say "swap" / "reapply" to exercise updateTools.`,
    );
  }
}

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load();
  },
  entry: async (ctx: JobContext) => {
    const locationToolset = new llm.Toolset({
      id: 'location_tools',
      tools: [
        llm.tool({
          name: 'getWeather',
          description: 'Get the weather for a given location.',
          parameters: z.object({ location: z.string() }),
          execute: async ({ location }) => `The weather in ${location} is sunny.`,
        }),
        llm.tool({
          name: 'lookupTimezone',
          description: 'Look up the timezone for a city or region.',
          parameters: z.object({ location: z.string() }),
          execute: async ({ location }) => `${location} is in the America/Los_Angeles timezone.`,
        }),
      ],
    });

    const session = new voice.AgentSession({
      vad: ctx.proc.userData.vad! as silero.VAD,
      stt: new inference.STT({ model: 'deepgram/nova-3', language: 'en' }),
      llm: new inference.LLM({ model: 'openai/gpt-4.1-mini' }),
      tts: new inference.TTS({
        model: 'cartesia/sonic-3',
        voice: '9626c31c-bec5-4cca-baa8-f8ba9e84c8bc',
      }),
      turnDetection: new livekit.turnDetector.MultilingualModel(),
    });

    await session.start({
      agent: new MainAgent(locationToolset),
      room: ctx.room,
      inputOptions: { noiseCancellation: BackgroundVoiceCancellation() },
    });

    session.say('Hello! I will ask you a quick question, then we can chat.');
  },
});

cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url) }));
