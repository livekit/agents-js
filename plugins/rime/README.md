<!--
SPDX-FileCopyrightText: 2024 LiveKit, Inc.

SPDX-License-Identifier: Apache-2.0
-->

# Rime plugin for LiveKit Agents

The Agents Framework is designed for building realtime, programmable
participants that run on servers. Use it to create conversational, multi-modal
voice agents that can see, hear, and understand.

This package contains the Rime plugin, which provides text-to-speech (TTS) and speech-to-text (STT). Refer to the
[documentation](https://docs.livekit.io/agents/overview/) for information on how to use it,
or browse the [API reference](https://docs.livekit.io/agents-js/modules/plugins_agents_plugin_rime.html).
See the [repository](https://github.com/livekit/agents-js) for more information
about the framework as a whole.

## Speech recognition

STT requires Node.js **22+** and the optional ESM-only Rime SDK. TTS keeps its existing
runtime and dependencies; importing this plugin or its declarations does not load the SDK.

```sh
pnpm add @livekit/agents-plugin-rime '@rimelabs/sdk@>=0.1.0-alpha.18 <0.1.0'
# For VAD-based recognition:
pnpm add @livekit/agents-plugin-silero
```

Set `RIME_API_KEY`. SDK alpha.18 is the tested minimum for unary recognition and both
streaming contracts. Construction is synchronous; the SDK is imported natively on the
first request in both ESM and CommonJS builds. Missing SDK and unsupported Node versions
produce actionable errors. No gRPC protocol is implemented in this plugin.

### Completed utterances

```ts
import { STT } from '@livekit/agents-plugin-rime';

const recognizer = new STT({
  language: 'en',
  mode: 'written',
  contextTerms: ['Rime', 'LiveKit'],
  connOptions: { timeoutMs: 10000, maxRetry: 2 },
});
try {
  const result = await recognizer.recognize(audioFrameOrFrames, abortSignal);
  console.log(result.alternatives?.[0].text);
} finally {
  await recognizer.close();
}
```

`recognize()` accepts an `AudioFrame` or an array with a consistent sample rate and channel
count. The plugin safely averages channels, resamples including buffered tail samples, and
sends complete mono 16 kHz PCM16 WAV (maximum 16 MiB). Empty/invalid audio fails without
retry. Successful silence returns an empty final. Results retain the resolved language and
request ID. Rime supplies no confidence or word/segment timestamps: required Node
`SpeechData.startTime`, `endTime`, and `confidence` are zero placeholders; `words` is absent.

For live audio without plugin-level VAD, supply VAD to `AgentSession`:

```ts
import { voice } from '@livekit/agents';
import * as rime from '@livekit/agents-plugin-rime';
import * as silero from '@livekit/agents-plugin-silero';

const detector = await silero.VAD.load();
const recognizer = new rime.STT({ connOptions: { timeoutMs: 120000 } });
const session = new voice.AgentSession({
  vad: detector,
  stt: recognizer,
  // Add your LLM and TTS.
  turnHandling: { turnDetection: 'vad', interruption: { mode: 'vad' } },
});
```

The session uses the existing `stt.StreamAdapter` to recognize each completed utterance.
There are no interim results in this path. You can also construct
`new stt.StreamAdapter(recognizer, detector)` explicitly.

### Native streaming

Pass VAD directly to the recognizer to upload audio while the user speaks. Each utterance
uses one SDK stream. Keep session VAD for immediate interruption detection while STT
publication waits for previous requests.

```ts
const recognizer = new rime.STT({
  vad: detector,
  outputContract: 'revised_hypotheses', // or 'append_fragments'
  connOptions: { timeoutMs: 120000, maxRetry: 0 },
});
const session = new voice.AgentSession({
  vad: detector,
  stt: recognizer,
  turnHandling: { turnDetection: 'stt', interruption: { mode: 'vad' } },
  connOptions: { sttConnOptions: { timeoutMs: 120000, maxRetry: 0 } },
  // Add your LLM and TTS.
});
```

`revised_hypotheses` replaces previous partial text. `append_fragments` concatenates deltas
exactly, including spaces and newlines. Both emit cumulative LiveKit interim snapshots.
Append mode currently uses five-second service windows; short utterances may have no
interim before speech ends. Individual fragments, EOF, errors, and cancellation never
fabricate finals. A final requires SDK-confirmed protocol and transport completion.

Native input must be mono. The plugin resamples to 16 kHz and flushes buffered samples.
The detector must emit initial audio in `START_OF_SPEECH`, then new audio in `INFERENCE_DONE`
(as Silero does). `END_OF_SPEECH` contains the complete segment and is never uploaded again.
Subsequent utterances upload while earlier results remain pending. All boundaries and
transcripts publish in speech order: start, cumulative interims, final, usage, end.
Only the latest interim snapshot per waiting utterance is retained. The global pending
upload limit is 320,000 bytes (ten seconds of PCM); at most eight utterances may await
completion/publication. Overflow fails explicitly. Service/SDK duration limits also apply.

`flush()` finishes the active utterance and creates fresh segmentation, accepting further
audio while prior results finish. `endInput()` finishes an active utterance, including when
VAD has not emitted an end. `await stream.close()` cancels owned work without creating a
final. `await recognizer.close()` cancels and joins all streams, unary calls and lazy
initialization before closing the SDK. The plugin closes only detector streams it creates;
the supplied VAD remains caller-owned. Close your session before closing the recognizer,
then close the shared detector when no other component uses it.

### Options, deadlines and Python differences

| Option           | Default                | Meaning                                                              |
| ---------------- | ---------------------- | -------------------------------------------------------------------- |
| `language`       | `'en'`                 | Explicit language passed unchanged to Rime, not automatic detection. |
| `mode`           | `'written'`            | Written forms, or `'verbatim'` for spoken forms.                     |
| `contextTerms`   | `[]`                   | Copied recognition hints.                                            |
| `apiKey`         | `RIME_API_KEY`         | Captured during synchronous construction.                            |
| `vad`            | absent                 | Enables native streaming when supplied.                              |
| `outputContract` | `'revised_hypotheses'` | `'append_fragments'` requires plugin-level VAD.                      |
| `connOptions`    | LiveKit defaults       | `timeoutMs: 10000`, `maxRetry: 3`, `retryIntervalMs: 2000`.          |

`updateOptions({ language, mode, contextTerms, connOptions })` changes subsequent requests.
User terms and framework session keyterms are copied, merged and deduplicated in stable
order. Options are captured at each unary request or VAD speech start.

Unlike Python, Node's base `recognize(audio, abortSignal?)` has no per-call language or
connection options. Use constructor/`updateOptions()` defaults, including for session
`StreamAdapter` calls; the adapter's session connection options are not forwarded to unary
recognition. `stream({ connOptions })` and native session STT connection options override
plugin defaults. Native streams capture their connection options at stream construction.

Timeouts and VAD durations use **milliseconds** in Node. The plugin explicitly converts
STT deadlines to **seconds** at the SDK boundary; recognition usage remains seconds.
Deadlines cover SDK initialization, speaking/uploading and response completion, so choose
a long enough streaming timeout. Only unary timeout/unavailability errors can retry;
native streaming always disables retries and audio replay, regardless of `maxRetry`.
Retries retain the original request snapshot. AbortSignal and close cancel unary retries.
Errors retain request IDs without provider messages, bodies, sensitive causes, or invented
HTTP statuses (`APIStatusError.statusCode` uses LiveKit's unknown sentinel, `-1`).

Node has no Python `speech_start_time` field. Start `createdAt` records wall-clock VAD
receipt before deferred publication. Finals/end events carry estimated wall-clock
`speechEndTime` (receipt time minus VAD silence/inference duration). Silero's VAD timestamps
are relative audio offsets and are not copied into these epoch-based fields. The Node turn
consumer still detects start on receipt; this is not word-level or sample-accurate timing.
Session VAD provides immediate activity and interruptions even when an earlier final delays
STT publication.

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
