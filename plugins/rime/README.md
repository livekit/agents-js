<!--
SPDX-FileCopyrightText: 2024 LiveKit, Inc.

SPDX-License-Identifier: Apache-2.0
-->

# Rime plugin for LiveKit Agents

The Agents Framework is designed for building realtime, programmable
participants that run on servers. Use it to create conversational, multi-modal
voice agents that can see, hear, and understand.

Rime provides text-to-speech, speech recognition, and Prism realtime speech-to-speech.
See the [LiveKit documentation](https://docs.livekit.io/agents/overview/),
[API reference](https://docs.livekit.io/agents-js/modules/plugins_agents_plugin_rime.html),
and [framework source](https://github.com/livekit/agents-js).

## Prism realtime

Prism handles speech input and output through `voice.AgentSession`. It requires
server turn detection and Node.js 22 or later. ESM and CommonJS are supported.

Set `RIME_API_KEY`. In your agent entrypoint, use the room from your job context:

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

Connection options also accept an `apiKey` or SDK `client`. If you supply a client,
you must close it yourself. The default endpoint is `wss://prism.api.rime.ai/v1/realtime`.
Omit `voice` to use the deployment default. For a trusted host outside `rime.ai`, set
`allowCustomEndpoint: true`. Remote endpoints require WSS; loopback IPs can use WS.

### Settings and tools

Use `await agent.updateInstructions()` and `await agent.updateTools()` for agent settings.
For provider settings, call
`await model.updateSession({ voice, truncation, responseMetadata, toolFillers })`.
Omitted fields keep their values. `model.sessionInfo` returns confirmed settings;
`await model.getHistory()` reads provider history without replacing local history.
On a direct Prism session, `await session.generateReply('Check in', {
  metadata: { step: '3' },
})` labels one requested reply. These labels replace matching session labels.
Replies that Prism starts from caller speech use session labels.

LiveKit executes tools. The plugin submits each result once and requests a continuation.
To add filler speech, use the registered tool name:
`toolFillers: { lookup: { type: 'text', text: 'Checking your order.' } }`.

Updates are not atomic. Each accepted setting remains applied if a later update fails.
With `toolChoice: 'none'`, the plugin removes tools until Prism accepts the reply or
the request is cancelled, then restores them. The SDK cancels responses accepted after
cancellation. An automatic speech reply can start during that gap with no tools.
This also applies when LiveKit reaches `maxToolSteps`. Failed tool restoration closes
the session.

### Shared history and recovery

History defaults to `contextMode: 'shared'`. Updates preserve omitted provider items,
accept new items at the end, and reject conflicting edits. Known generated, played,
and retained transcript variants do not overwrite provider text. Use
`contextMode: 'strict'` for exact replacement through ordinary updates.

Use these model methods for explicit edits to an active agent:

`await model.replaceChatCtx(agent, target)`
`await model.clearChatCtx(agent)`
`await model.reconcileChatCtx(agent)`

Pause competing edits and agent handoffs first. Reconciliation copies confirmed
history into the agent without provider writes. Replacement attempts reconciliation
if a known failure leaves the local context different. Pending calls cannot be removed.
The helpers preserve parent tool calls even if the current agent has fewer tools.

A failed edit raises `realtime.PrismHistoryUpdateError`. Its `status` is
`rejected`, `partial`, or `uncertain`. Inspect `recoverable`,
`confirmedChatCtx`, and `needsReconciliation`. The optional synchronous
`onHistoryUpdate` callback receives these facts before automatic repair.
A known refusal or partial edit preserves accepted writes and permits later work.
An unknown write outcome closes the session. The plugin never retries history writes.
To retry missing tool results, append them to the latest confirmed context.

A refused typed input stops its reply. The current JavaScript core catches tool-result
update failures and can still request a reply. Such a reply uses an accepted tool result
when one is available. Unlike the Python core, the JavaScript core does not stop that
dependent step. Applications that require this behavior must handle the history notice
and stop the affected speech. No shared core code is changed by this plugin.

### Interruption and limits

For application stop, use `session.interrupt()` to cancel the provider response.
With the repository core, `SpeechHandle.interrupt()` also cancels the provider
response before the first message, during audio, and clears queued playback after
generation ends. Published core 1.9.4 does not notify the provider between response
creation and the first message.

The default `playback: 'auto'` uses measured playback when you install the wrapper:

`session.output.audio = model.wrapAudioOutput(session.output.audio!)`

Install it after the output exists and before generating speech. It reads frame identity
before resampling and reports completion only when all generated audio has confirmed
playback. Missing frames, changed frame identity, interrupted output, and ambiguous
completion retain server estimates. SDK response holds expire after a bounded wait.
Use `playback: 'estimated'` to keep estimates, or `playback: 'discard'` for
text and tool workflows that discard audio and report zero played duration.
Interrupted playback reports still use the requested cut position. Early speech hints
do not lower the volume.

These limits apply:

- One open realtime session per model. Close it before starting a fresh conversation.
  Closing the model prevents new sessions. There is no custom fallback session.
- Server turn detection is required. Manual audio commits are unsupported.
- Tool choice accepts `auto` and `none`. Tools must be functions.
- History accepts text and completed tool calls/results. Pending calls cannot resume
  in a fresh session. Typed input enters history before the reply request.
- PCM16 input is downmixed or resampled when needed. Output is 24 kHz mono PCM16.
  Queues are bounded; overflow closes the session.

The realtime session emits SDK payloads as `item_truncated` and `response_ended`.
`rime_server_event_received` exposes each SDK event before plugin processing.
`metrics_collected` emits one final usage record per response, including cancelled
responses. Time to first audio uses the first nonempty provider audio chunk.
`response_ended.usage` reports token counts when Prism provides them.
Available `keptText` updates the plugin's history while the server item ID still
matches. An empty string means no words remain; `null` means unavailable and leaves
known text unchanged. Early acknowledgments may have no retained text, with no later
update guaranteed. Retained text can differ from the words heard and does not replace
LiveKit's playback transcript.

`response_ended.truncation` reports items excluded from that reply's prompt through
`itemsLeftOut` and `firstKeptItemId`. It does not delete local history or change the
truncation policy. A missing or null summary means no exclusions were reported or the
information was unavailable. Diagnostics include discarded replies and can arrive
before `generateReply()` returns a requested response.

`generation.instructionItemId` names a saved instruction from an explicit
reply. After that reply ends, call `await model.deleteInstructionItem(id)` to
remove it from later Prism history. The method accepts only IDs observed in
this session while they remain among the last 128 saved instruction IDs that
the adapter observed.
It does not change local LiveKit history. An idle close produces
`PrismIdleTimeoutError` in the session error event, with `idleTimeoutS` in seconds.

### Configuration and compatibility

Constructor options include turn detection, history truncation, request IDs, response
metadata, and tool fillers. Timeouts use milliseconds. See
[`RealtimeModelOptions`](src/realtime/realtime_model.ts) for defaults.

Initial connection retries use `connOptions` and the overall `startupTimeout`
budget. Only explicit transient upgrade statuses are retried. Cancellation,
acknowledgment uncertainty, and established-session failures are not retried.
The plugin does not provide a custom fallback session.

The plugin pins `@rimelabs/sdk` to `0.1.0-alpha.28` from public npm. If your machine
routes `@rimelabs` to GitHub Packages, install with
`pnpm install --@rimelabs:registry=https://registry.npmjs.org`.

## Speech recognition

`new STT({ language: 'en', mode: 'written', contextTerms: ['Rime'] })` supports
whole recordings through `recognize(audio)`. It downmixes and resamples to mono
16 kHz WAV. Recordings have a 16 MiB limit. `mode: 'verbatim'` is also supported.
`updateOptions` changes language, mode, and context terms for later requests.
Session keyterms merge with configured terms without duplicates.

Pass a LiveKit VAD to enable native streaming. This path is tested with Silero.
Custom VADs must report inference frames and queue the speech events for each
inference window together. The plugin uses these events to drain input before
flush or shutdown:

`new STT({ vad, outputContract: 'append_fragments' })`

The default output contract is `revised_hypotheses`. Append fragments preserve
whitespace and produce cumulative interim transcripts. Each VAD utterance uses one
SDK stream. Final transcripts require provider confirmation and retain utterance
order. Streaming input must be mono. A stream permits eight pending utterances and
ten seconds of queued upload audio. Overflow fails without replaying audio.
Whole-recording requests can retry transport failures through `connOptions`;
streaming requests never replay. Closing STT cancels active work. Injected SDK clients
and VADs remain caller-owned.

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

Coda accepts `customLexicon: [{ spelling: 'Rime', pronunciation: '" r aI m' }]`
on HTTP and WebSocket v1. Pronunciations use space-separated X-SAMPA. The plugin copies entries when it snapshots options.
Mist and legacy WS3 reject this option. The default speakers are `lyra` for Coda
and `cove` for Mist; an explicit speaker takes precedence.

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
