<!--
SPDX-FileCopyrightText: 2025 LiveKit, Inc.

SPDX-License-Identifier: Apache-2.0
-->

# Inworld plugin for LiveKit Agents

The Agents Framework is designed for building realtime, programmable
participants that run on servers. Use it to create conversational, multi-modal
voice agents that can see, hear, and understand.

This package contains the Inworld plugin, which provides TTS, STT, and the
Inworld Realtime API. Refer to the
[documentation](https://docs.livekit.io/agents/overview/) for information on how
to use it.

See the [repository](https://github.com/livekit/agents-js) for more information
about the framework as a whole.

## Setup

Install the plugin and set `INWORLD_API_KEY` in your environment. Inworld API
keys are already base64-encoded, so pass the key exactly as issued — the plugin
sends it as an HTTP `Basic` credential and does not re-encode it.

```bash
export INWORLD_API_KEY=<your key>
```

## Realtime

`inworld.realtime.RealtimeModel` is a speech-to-speech model: a single session
handles transcription, the LLM turn, and speech synthesis. Drop it in as the
`llm` on an `AgentSession` and omit `stt`, `tts`, and `vad`.

```ts
import { voice } from '@livekit/agents';
import * as inworld from '@livekit/agents-plugin-inworld';

const session = new voice.AgentSession({
  llm: new inworld.realtime.RealtimeModel({
    model: 'openai/gpt-4o-mini',
    voice: 'Ashley',
  }),
});
```

Inworld speaks the OpenAI Realtime wire protocol, so this class extends the
OpenAI plugin's `realtime.RealtimeModel` and inherits its behavior for turn
detection, interruption, chat context synchronization, and reconnection. That
also means `@livekit/agents-plugin-openai` is a peer dependency of this package.

### Options

`model` selects the LLM driving the conversation and must use the full
`provider/model` form, defaulting to `openai/gpt-4o-mini`. `voice` and `ttsModel`
control synthesis, defaulting to `Ashley` and `inworld-tts-2`. `sttModel`
controls user transcription and defaults to `inworld/inworld-stt-1`; it is a
convenience over the inherited `inputAudioTranscription` option, and is ignored
if you set that option explicitly. `apiKey` falls back to `$INWORLD_API_KEY`, and
`baseURL` defaults to `wss://api.inworld.ai/api/v1/realtime/session` — supplying
an `http`/`https` URL is fine, as the scheme is rewritten to `ws`/`wss`. All
remaining options from the OpenAI Realtime model, such as `turnDetection`,
`modalities`, `toolChoice`, and `connOptions`, are accepted unchanged.

### Provider data

Inworld-specific session settings live under `providerData`, which is serialized
verbatim into the initial `session.update`. It covers speech recognition hints
(`stt`), synthesis behavior (`tts`), long-term memory (`memory`), backchannels
(`backchannel`), turn-taking latency (`responsiveness`), prompt caching
(`caching`), LLM sampling (`text_generation_config`), and passthrough
`user_id`/`metadata` fields.

```ts
new inworld.realtime.RealtimeModel({
  providerData: {
    stt: { language_code: 'en-US', enable_automatic_punctuation: true },
    tts: { delivery_mode: 'BALANCED', timestamp_type: 'WORD' },
    responsiveness: { level: 0.6 },
    text_generation_config: { maxNewTokens: 256, topP: 0.9 },
  },
});
```

Note the mixed casing: most of the tree is snake_case, but
`text_generation_config` and its nested `reasoning` object use camelCase. This
matches the Inworld wire format and is intentional — the TypeScript types in
`inworld.realtime.ProviderData` encode it, so your editor will tell you which
form a given field wants.

### Tool calls and `auto_tool_response`

`providerData.auto_tool_response` defaults to `false`, which means the Inworld
server does not automatically speak after a tool returns a result. Turn
continuation is left to the agent, so a tool result flows back through the
LiveKit voice pipeline and the agent decides whether to generate a follow-up
reply — that is what makes `voiceOptions.maxToolSteps` work for chained tool
calls. Set it to `true` if you would rather have Inworld drive the follow-up
response itself, in which case the agent will not add a step of its own.

### Debugging

The session inherits two raw wire events from the OpenAI base session, which are
the fastest way to diagnose a protocol-level problem:
`openai_server_event_received` fires for every event received from Inworld, and
`openai_client_event_queued` fires for every event the plugin is about to send.

```ts
const session = model.session();
session.on('openai_client_event_queued', (ev) => console.log('->', ev.type));
session.on('openai_server_event_received', (ev) => console.log('<-', ev.type));
```

To exercise a session end to end without a LiveKit room, a worker, or a connected
participant, run the standalone smoke script — it needs only `INWORLD_API_KEY`:

```bash
pnpm build && node ./examples/src/test_inworld_realtime.ts
```

For a full voice agent, see `examples/src/inworld_realtime.ts`.
