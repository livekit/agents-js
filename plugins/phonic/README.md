# @livekit/agents-plugin-phonic

Realtime voice AI integration for [Phonic](https://phonic.co/) with LiveKit Agents.

## Usage

```typescript
import { type JobContext, ServerOptions, cli, defineAgent, llm, voice } from '@livekit/agents';
import * as phonic from '@livekit/agents-plugin-phonic';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const toggleLight = llm.tool({
  description: 'Toggle a light on or off. Available lights are A05, A06, A07, and A08.',
  parameters: z.object({
    light_id: z.string().describe('The ID of the light to toggle'),
    state: z.enum(['on', 'off']).describe('Whether to turn the light on or off'),
  }),
  execute: async ({ light_id, state }) => {
    console.log(`Turning ${state} light ${light_id}`);
    return `Light ${light_id} turned ${state}`;
  },
});

export default defineAgent({
  entry: async (ctx: JobContext) => {
    const agent = new voice.Agent({
      instructions: 'You are a helpful voice AI assistant named Alex.',
      tools: {
        toggle_light: toggleLight,
      },
    });

    const session = new voice.AgentSession({
      // Uses PHONIC_API_KEY environment variable when apiKey is not provided
      llm: new phonic.realtime.RealtimeModel({
        voice: 'sabrina',
        welcomeMessage: 'Hey there, how can I help you today?',
        audioSpeed: 1.2,
      }),
    });

    await session.start({
      agent,
      room: ctx.room,
    });

    await ctx.connect();
  },
});

cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url) }));
```

## Configuration

Set the `PHONIC_API_KEY` environment variable, or pass `apiKey` directly to `RealtimeModel`. All other options are optional.

| Option | Type | Description |
| --- | --- | --- |
| `apiKey` | `string` | Phonic API key. Falls back to `PHONIC_API_KEY` environment variable |
| `model` | `string` | Model name (default: `merritt`) |
| `phonicAgent` | `string` | Phonic agent name. Options set explicitly here override agent settings |
| `voice` | `string` | Voice ID — `sabrina`, `grant`, `virginia`, `landon`, `eleanor`, `shelby`, `nolan` |
| `welcomeMessage` | `string` | Message the agent says when the conversation starts. Ignored when `generateWelcomeMessage` is true |
| `generateWelcomeMessage` | `boolean` | Auto-generate the welcome message (ignores `welcomeMessage`) |
| `project` | `string` | Project name (default: `main`) |
| `languages` | `string[]` | ISO 639-1 language codes the agent should recognize and speak |
| `audioSpeed` | `number` | Audio playback speed |
| `phonicTools` | `string[]` | [Phonic Webhook tool](https://docs.phonic.co/docs/using-tools/tools_overview#webhook-tools) names available to the assistant |
| `boostedKeywords` | `string[]` | Keywords to boost in speech recognition |
| `generateNoInputPokeText` | `boolean` | Auto-generate poke text when user is silent |
| `noInputPokeSec` | `number` | Seconds of silence before sending poke message |
| `noInputPokeText` | `string` | Poke message text (ignored when `generateNoInputPokeText` is true) |
| `noInputEndConversationSec` | `number` | Seconds of silence before ending conversation |

If you already have an agent set up on the Phonic platform, you can use the `phonicAgent` option to specify the agent name. As a note, configuration options you set in the LiveKit Agents SDK will override the agent settings set on the Phonic platform. This means the system prompt you have set on the Phonic platform will be ignored in favor of the `instructions` field set on the LiveKit `voice.Agent`. Likewise, options explicitly set in the `RealtimeModel` constructor will override the Phonic agent's settings. 

If you have Webhook tools set up on the Phonic platform, you can use `phonicTools` to make them available to your agent. Only [Phonic Webhook tools](https://docs.phonic.co/docs/using-tools/tools_overview#webhook-tools) are supported with LiveKit Agents.
