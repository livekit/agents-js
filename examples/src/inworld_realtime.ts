// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
//
// Ref: python examples/voice_agents/inworld_realtime_api.py
// Requires INWORLD_API_KEY, LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET.
// Run: pnpm build && node ./examples/src/inworld_realtime.ts dev --log-level=debug
import {
  type JobContext,
  ServerOptions,
  cli,
  defineAgent,
  llm,
  metrics,
  voice,
} from '@livekit/agents';
import * as inworld from '@livekit/agents-plugin-inworld';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const getWeather = llm.tool({
  name: 'getWeather',
  description: 'Called when the user asks about the weather.',
  parameters: z.object({
    location: z.string().describe('The location to get the weather for'),
  }),
  execute: async ({ location }) => {
    return `The weather in ${location} is sunny today. The temperature is 70 degrees Fahrenheit.`;
  },
});

class WeatherAgent extends voice.Agent {
  constructor() {
    super({
      instructions:
        'You are a helpful assistant created by LiveKit. Keep replies to one or two short sentences.',
      tools: [getWeather],
    });
  }

  async onEnter(): Promise<void> {
    this.chatCtx.addMessage({
      role: 'assistant',
      content: 'I can look up the weather. Which city are you in?',
    });
    await this.updateChatCtx(this.chatCtx);

    this.session.generateReply({
      instructions: 'Greet the user and offer to check the weather for them.',
    });
  }
}

export default defineAgent({
  entry: async (ctx: JobContext) => {
    const session = new voice.AgentSession({
      llm: new inworld.realtime.RealtimeModel({
        voice: 'Ashley',
        ttsModel: 'inworld-tts-2',
        sttModel: 'inworld/inworld-stt-1',
        providerData: {
          // false (default): agent owns post-tool turns so maxToolSteps can chain.
          auto_tool_response: false,
          tts: { delivery_mode: 'BALANCED' },
          responsiveness: { level: 0.6 },
        },
      }),
      voiceOptions: {
        maxToolSteps: 5,
      },
    });

    session.on(voice.AgentSessionEventTypes.MetricsCollected, (ev) => {
      metrics.logMetrics(ev.metrics);
    });

    await session.start({
      agent: new WeatherAgent(),
      room: ctx.room,
    });
  },
});

cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url) }));
