# @livekit/agents-plugin-phonic

Realtime voice AI integration for [Phonic](https://phonic.ai/) with LiveKit Agents.

## Usage

```typescript
// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
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
    await new Promise((resolve) => setTimeout(resolve, 1_000));
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
        audioSpeed: 1.2,
      }),
    });

    await session.start({
      agent,
      room: ctx.room,
    });

    await ctx.connect();

    await session.generateReply({
      instructions: 'Greet the user, asking about their day.',
    });
  },
});

cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url) }));
```

### Reusing tools with Phonic Responses

Convert an existing LiveKit `ToolContext` into the schema-only definitions accepted by Phonic's
Responses API:

```typescript
import * as phonic from '@livekit/agents-plugin-phonic';

const toolDefinitions = phonic.realtime.toPhonicToolDefinitions(toolContext);
```

The executable functions remain in the `ToolContext`; only their names, descriptions, and parameter
schemas are returned.

## Configuration

Set the `PHONIC_API_KEY` environment variable, or pass `apiKey` directly to `RealtimeModel`. All other options are optional.

| Option                               | Type                                       | Description                                                                                                                                                                                                                                                 |
| ------------------------------------ | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apiKey`                             | `string`                                   | Phonic API key. Falls back to `PHONIC_API_KEY` environment variable                                                                                                                                                                                         |
| `model`                              | `string`                                   | Model name (default: `merritt`)                                                                                                                                                                                                                             |
| `phonicAgent`                        | `string`                                   | Phonic agent name. Options set explicitly here override agent settings                                                                                                                                                                                      |
| `voice`                              | `string`                                   | Voice ID — `sabrina`, `grant`, `virginia`, `landon`, `eleanor`, `shelby`, `nolan`                                                                                                                                                                           |
| `welcomeMessage`                     | `string`                                   | Message the agent says when the conversation starts. Ignored when `generateWelcomeMessage` is true                                                                                                                                                          |
| `generateWelcomeMessage`             | `boolean`                                  | Auto-generate the welcome message (ignores `welcomeMessage`)                                                                                                                                                                                                |
| `project`                            | `string`                                   | Project name (default: `main`)                                                                                                                                                                                                                              |
| `defaultLanguage`                    | `string`                                   | ISO 639-1 default language for recognition and speech                                                                                                                                                                                                       |
| `additionalLanguages`                | `string[]`                                 | Further ISO 639-1 codes (must not repeat `defaultLanguage`)                                                                                                                                                                                                 |
| `multilingualMode`                   | `'auto'` \| `'request'`                    | Per-utterance language detection vs. change on user request (recommended: `request`)                                                                                                                                                                        |
| `audioSpeed`                         | `number`                                   | Audio playback speed                                                                                                                                                                                                                                        |
| `phonicTools`                        | `string[]`                                 | Names of Phonic-side tools available to the assistant: [Webhook tools](https://docs.phonic.ai/docs/using-tools/tools_overview#webhook-tools) and [built-in tools](#built-in-tools) (`choose_not_to_respond`, `keypad_input`, `natural_conversation_ending`) |
| `boostedKeywords`                    | `string[]`                                 | Keywords to boost in speech recognition                                                                                                                                                                                                                     |
| `minWordsToInterrupt`                | `number`                                   | Minimum number of user words required to interrupt the assistant                                                                                                                                                                                            |
| `generateNoInputPokeText`            | `boolean`                                  | Auto-generate poke text when user is silent                                                                                                                                                                                                                 |
| `noInputPokeSec`                     | `number`                                   | Seconds of silence before sending poke message                                                                                                                                                                                                              |
| `noInputPokeText`                    | `string`                                   | Poke message text (ignored when `generateNoInputPokeText` is true)                                                                                                                                                                                          |
| `noInputEndConversationSec`          | `number`                                   | Seconds of silence before ending conversation                                                                                                                                                                                                               |
| `websocketTimeoutSec`                | `number`                                   | Seconds of inactivity before the Phonic websocket is closed                                                                                                                                                                                                 |
| `intelligenceLevel`                  | `'standard'` \| `'high'`                   | LLM intelligence level                                                                                                                                                                                                                                      |
| `isWelcomeMessageInterruptible`      | `boolean`                                  | When false, the welcome message cannot be interrupted                                                                                                                                                                                                       |
| `vadPrebufferDurationMs`             | `number`                                   | Voice-activity-detection prebuffer duration (ms)                                                                                                                                                                                                            |
| `vadMinSpeechDurationMs`             | `number`                                   | Minimum speech duration for VAD (ms)                                                                                                                                                                                                                        |
| `vadMinSilenceDurationMs`            | `number`                                   | Minimum silence duration for VAD (ms)                                                                                                                                                                                                                       |
| `vadThreshold`                       | `number`                                   | Voice-activity-detection threshold                                                                                                                                                                                                                          |
| `enableAssistantBackchannel`         | `boolean`                                  | When true, the assistant backchannels (e.g. "mm-hmm") while the user speaks                                                                                                                                                                                 |
| `assistantBackchannelAggressiveness` | `number`                                   | How aggressively the assistant backchannels (needs `enableAssistantBackchannel`)                                                                                                                                                                            |
| `pronunciationDictionary`            | `{ word, pronunciation }[]`                | Pronunciation entries; words must be unique                                                                                                                                                                                                                 |
| `templateVariables`                  | `Record<string, string>`                   | Variables substituted into the system prompt and welcome message                                                                                                                                                                                            |
| `enableRedaction`                    | `boolean`                                  | Redact PII/PHI from transcripts and bleep it from audio after the conversation                                                                                                                                                                              |
| `enableWatermarking`                 | `boolean`                                  | Embed an inaudible provenance watermark in generated audio. Adds a very small amount of latency                                                                                                                                                             |
| `mcpServers`                         | `string[]`                                 | Names of pre-configured MCP servers to make available (must be unique)                                                                                                                                                                                      |
| `observabilityIntegrations`          | `'braintrust'[]`                           | Observability integrations to forward traces to                                                                                                                                                                                                             |
| `configurationEndpoint`              | `{ url, headers?, timeout_ms? }` \| `null` | Endpoint the agent calls to fetch per-conversation configuration                                                                                                                                                                                            |
| `additionalParams`                   | `Record<string, unknown>`                  | Additional runtime parameters forwarded to Phonic                                                                                                                                                                                                           |
| `configsForTools`                    | `PhonicToolConfig[]`                       | Per-tool behavior overrides (see [Per-tool configuration](#per-tool-configuration))                                                                                                                                                                         |
| `onConversationCreated`              | `(conversationId: string) => void`         | Callback invoked with the Phonic conversation ID when the conversation is created                                                                                                                                                                           |

### Per-tool configuration

`configsForTools` takes one entry per tool you want to customize. Each entry is keyed by the tool `name`; every other field is optional and falls back to the plugin default when omitted. Tools with no entry keep the defaults.

```typescript
new phonic.realtime.RealtimeModel({
  configsForTools: [
    { name: 'transfer_call', forbid_speech_after_tool_call: true },
    { name: 'submit_form', forbid_tool_call_after_speech: true },
  ],
});
```

| Field                             | Type      | Default | Description                                                                                                                                                             |
| --------------------------------- | --------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                            | `string`  | —       | Tool this config applies to (required)                                                                                                                                  |
| `require_speech_before_tool_call` | `boolean` | `false` | Require the agent to speak before the tool can be called                                                                                                                |
| `forbid_speech_after_tool_call`   | `boolean` | `false` | Suppress the auto-generated spoken reply after the tool. Use for tools that always hand off to another agent (a non-handoff tool set here would leave the agent silent) |
| `forbid_tool_call_after_speech`   | `boolean` | `false` | Drop the tool call if the agent already spoke this turn                                                                                                                 |
| `respond_after_sec`               | `number`  | —       | **`choose_not_to_respond` only.** Seconds to wait after the tool fires; if the user stays silent, the agent speaks a follow-up. Omit to keep the default (stay silent). |
| `speech_before_tool_call`         | `string`  | —       | **`keypad_input` / `natural_conversation_ending` only.** `required` \| `optional` \| `suppressed`.                                                                      |

The plugin always sends tool calls with `wait_for_speech_before_tool_call` on and `allow_tool_chaining` off; these are not configurable per tool.

> **Deprecated:** the top-level `forbidSpeechAfterToolCall: string[]` option still works but is deprecated — it now folds each listed tool into `configsForTools` as `forbid_speech_after_tool_call: true` (an explicit `configsForTools` entry wins) and logs a warning. Prefer `configsForTools`.

### Built-in tools

Phonic's built-in tools — `choose_not_to_respond`, `keypad_input`, `natural_conversation_ending` — are enabled by listing their names in `phonicTools`, alongside any Webhook tools. To configure one, add a `configsForTools` entry keyed by the same name (`respond_after_sec` for `choose_not_to_respond`; `speech_before_tool_call` for the other two). A built-in listed without a config uses its Phonic-side defaults.

```typescript
new phonic.realtime.RealtimeModel({
  phonicTools: ['choose_not_to_respond', 'keypad_input'],
  configsForTools: [{ name: 'choose_not_to_respond', respond_after_sec: 5 }],
});
```

If you already have an agent set up on the Phonic platform, you can use the `phonicAgent` option to specify the agent name. As a note, configuration options you set in the LiveKit Agents SDK will override the agent settings set on the Phonic platform. This means the system prompt you have set on the Phonic platform will be ignored in favor of the `instructions` field set on the LiveKit `voice.Agent`. Likewise, options explicitly set in the `RealtimeModel` constructor will override the Phonic agent's settings.

If you have Webhook tools set up on the Phonic platform, you can use `phonicTools` to make them available to your agent, together with Phonic's [built-in tools](#built-in-tools). Custom function tools you define on the LiveKit `voice.Agent` are also supported and run over the websocket.
