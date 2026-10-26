<!--
SPDX-FileCopyrightText: 2024 LiveKit, Inc.

SPDX-License-Identifier: Apache-2.0
-->

# Rime plugin for LiveKit Agents

The Agents Framework is designed for building realtime, programmable
participants that run on servers. Use it to create conversational, multi-modal
voice agents that can see, hear, and understand.

This package provides Rime text-to-speech and Prism realtime speech-to-speech. Refer to the
[documentation](https://docs.livekit.io/agents/overview/) for information on how to use it,
or browse the [API reference](https://docs.livekit.io/agents-js/modules/plugins_agents_plugin_rime.html).
See the [repository](https://github.com/livekit/agents-js) for more information
about the framework as a whole.

## Prism realtime

Prism uses the standard `voice.AgentSession`. This package requires Node.js 22 or later
and pins `@rimelabs/sdk` to `0.1.0-alpha.22`. Both ESM and CommonJS package imports load
the SDK during asynchronous session setup. Existing TTS exports remain available.
The SDK is published on the public npm registry. If your machine routes the
`@rimelabs` scope to GitHub Packages, use
`pnpm install --@rimelabs:registry=https://registry.npmjs.org` for installation.
This does not change the pinned versions of the existing Rime API dependencies.

```ts
import { voice } from '@livekit/agents';
import { realtime } from '@livekit/agents-plugin-rime';

const model = new realtime.RealtimeModel({
  voice: process.env.PRISM_VOICE,
});
const session = new voice.AgentSession({ llm: model });
await session.start({
  agent: new voice.Agent({ instructions: 'Give short replies in English.' }),
  room, // The LiveKit room from your job context.
});
session.generateReply({ userInput: 'Hello.' });
```

Set `RIME_API_KEY`, or pass `apiKey` or a caller-owned SDK `client`. An injected client
remains open when the plugin closes. The default endpoint is
`wss://prism.api.rime.ai/v1/realtime`. A voice is optional when the deployment has a
default. Custom endpoints follow the same trust and secure-connection rules as TTS;
set `allowCustomEndpoint: true` for a trusted host outside `rime.ai`.

The constructor accepts `turnDetection`, context `truncation`, `requestId`,
`responseMetadata`, and `toolFillers`. `connectTimeout`, `readyTimeout`, and
`requestTimeout` use milliseconds and default to 10000, 30000, and 10000.
`turnDetection.endOfTurnTimeoutMs` also uses milliseconds. Context truncation controls
history size at the provider; it is separate from interruption playback reports.

Use `agent.updateInstructions()` and `agent.updateTools()` for agent settings.
Use `await model.updateSession({ voice, truncation, responseMetadata, toolFillers })`
for provider settings. Omit fields that should not change. `model.sessionInfo` returns
acknowledged session information. `await model.getHistory()` reads a snapshot of
completed provider history without replacing the local conversation record.

LiveKit executes tools and the adapter submits each result once, then requests a
continuation. Completed tool history can be imported. Pending calls cannot be resumed
in a fresh session. A tool filler is keyed by its registered tool name, for example
`toolFillers: { lookup: { type: 'text', text: 'Checking your order.' } }`.

`toolChoice: 'none'` temporarily removes tools, waits for reply admission, then restores
them. This also supports LiveKit's `maxToolSteps` limit. These updates are not atomic:
an automatic speech reply can start while tools are absent. Settings revisions prevent
a late response from bypassing its tool restriction. A failed restoration closes the
session. Instructions, tools, history, and handoff updates are separate acknowledged
operations. A partially applied history edit also closes the session.

Use `session.interrupt()` to stop the application response. It cancels the owning
provider response; playback truncation reports use the supplied message identity.
In the tested JS core, direct `SpeechHandle.interrupt()` has one confirmed limit:
after response creation, while waiting for the first message, it does not notify the
provider. It works during audio and truncates queued audio after generation ends.
Use the session-level operation when provider cancellation is required.

Typed input is inserted into history before a reply request. It does not use Prism's
dedicated typed-turn operation. The adapter sends no normal playback-completion
receipts because the standard interface supplies no reliable completion measurement.
Prism uses its playback estimate. Early speech hints do not change volume.

Prism requires server turn detection. Disabling it, manually committing audio,
required or named tool choices, provider-specific non-function tools, media in history,
and pending-call resumption are unsupported. Use one active session per model. After
closing that session, the model can open a fresh conversation. The adapter provides no
custom fallback session.

Input accepts SDK-supported PCM16 mono/stereo rates directly. It downmixes additional
channels and resamples other rates. It combines adjacent unsent frames into batches of
at most 100 ms, without waiting to fill a batch. Limits are 100 input batches, 256
queued text/audio chunks per output, and 128 retained generations. Overflow closes the
session instead of dropping audio or increasing the queue without a bound.

Local protocol and standard-session tests cover the repository core at `f03a68ef` and
the separately installed published `@livekit/agents@1.9.4`, on Node.js 24.18.0.
These checks do not establish
support for older JS versions. Python version results do not establish JS compatibility.
The peer dependency remains the repository's fixed release version.

## WebSocket v1 streaming

WebSocket v1 requires both `websocketURL` and `modelId` at construction. The URL selects
the deployment. The model sets the plugin's defaults and available options. Set `RIME_API_KEY`
and pass both options:

```ts
import { TTS } from '@livekit/agents-plugin-rime';

const rime = new TTS({
  websocketURL: 'wss://coda.api.rime.ai/ws',
  modelId: 'coda',
  speaker: 'lyra',
});
```

Use `modelId: 'coda'` with `wss://coda.api.rime.ai/ws`, or `modelId: 'mistv3'` with
`wss://mist.api.rime.ai/ws`. Both public endpoints use port 443.

If your configuration relied on a model in the URL path, add `modelId` to the constructor.
The plugin does not read the model from the URL hostname or path.

Custom deployments can use any URL path. Pass the deployment URL and its model in
`websocketURL` and `modelId`.

For Coda, the default speaker is `lyra`. Mist uses `cove`. Pass `speaker` to use another voice.

`websocketProtocol` defaults to `binary`, with the `rime.v1.binary` subprotocol.
Set it to `json` for `rime.v1.json` and canonical protobuf JSON. Both modes use
the generated definitions from `@rimelabs/api@0.0.1`.

One stream uses one continuous synthesis context. Text fragments pass through a
LiveKit sentence tokenizer before transmission. The default tokenizer emits one
sentence at a time. A custom `tokenizer` must emit complete, stable sentence units.

| Stream method    | Behavior                                                   |
| ---------------- | ---------------------------------------------------------- |
| `pushText(text)` | Buffer text and send complete sentences.                   |
| `flush()`        | Release buffered text locally. Keep the context open.      |
| `endInput()`     | Send remaining text, then `end`. Wait for `done`.          |
| `close()`        | Stop synthesis and send `cancel` when a context is active. |

Only call `flush()` at a complete sentence or stable clause boundary. You can
send more text after a flush. No protocol `flush` message exists in v1.
An input pause can exceed the API timeout. Connection, write, start, and final
response waits remain bounded. Timeouts use milliseconds, as in other JS plugins.

Sequential streams reuse connections. Concurrent streams use separate connections.
After cancellation, the adapter reuses a connection only after a valid terminal
reply. Failed or contaminated connections are discarded. `prewarm()` opens an idle
connection. `await rime.close()` cancels streams and closes the pools.

`audioFormat` accepts `audio/pcm`, `audio/pcmu`, `audio/wav`, `audio/mpeg`,
`audio/ogg;codecs=opus`, and `audio/webm;codecs=opus`. Both protocols support all six
formats and return mono PCM frames at the selected `samplingRate`. Compressed
formats use the bundled LiveKit FFmpeg binary, or `LIVEKIT_FFMPEG_PATH` when set.
The default format is `audio/pcm`. WebSocket v1 does not provide word timestamps.

Use `timeScaleFactor` for speed control. Legacy generation controls, `speedAlpha`,
and WS3-only options are rejected in v1. Mist accepts `pauseBetweenBrackets` and
`phonemizeBetweenBrackets`.

The plugin sends the API key to the configured endpoint. It trusts `rime.ai` and
its subdomains. Set `allowCustomEndpoint: true` to use another trusted host.
Remote endpoints must use HTTPS or WSS. Loopback IP addresses can use HTTP or WS.
Provider messages, response bodies, close reasons, and transport errors are not
included in returned errors. Safe status codes and provider request IDs remain available.

## Existing HTTP and WS3 interfaces

Without `websocketURL`, the plugin retains HTTP synthesis and the legacy WS3
interface selected with `useWebsocket` or a WebSocket `baseURL`. HTTP and WS3
retain their existing speaker defaults and options. WS3 retains word timestamps.
Mist v2 defaults to 22050 Hz; Coda and Mist v3 default to 24000 Hz. HTTP requests
send the resolved rate explicitly.

`updateOptions()` applies to new streams. Existing streams keep their original
options and endpoint. A v1 model change requires a different model endpoint.
Changing only the URL query does not change the model. Transport mode cannot
change after construction.

## Tests

Run `pnpm exec vitest run plugins/rime/src` from the repository root after building
`@livekit/agents`. The local tests need no API keys. The optional service test needs
both `RIME_API_KEY` and `OPENAI_API_KEY`.

The audio tests generate WAV, MP3, Ogg, and WebM samples at test setup. Install a
full FFmpeg build with `libmp3lame` and `libopus` on `PATH` to run these tests. The
bundled LiveKit FFmpeg supports playback but does not include all required encoders
and output formats.
