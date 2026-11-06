<!--
SPDX-FileCopyrightText: 2026 LiveKit, Inc.

SPDX-License-Identifier: Apache-2.0
-->

# Microsoft AI speech plugin for LiveKit Agents

Microsoft AI speech-to-text and Azure Speech text-to-speech for LiveKit Agents.

**STT and Azure Speech TTS have bounded live smoke coverage in the upstream
implementation.** TTS was verified with MAI-Voice-2-Flash (Harper, PCM16 mono at
24 kHz), including playback through a local LiveKit room. Streaming STT separately
transcribed one short synthetic English utterance through the Azure GA transcription
route with explicit `api-key` authentication and PCM16 mono at 16 kHz. The acknowledged
final matched every expected word, including the last word, without added silence or
promotion of an interim hypothesis. The endpoint acknowledged the configured rate before
audio was sent.

A separate five-turn synthetic browser/WebRTC test passed through a local LiveKit server,
real Microsoft AI STT with its own local VAD, the model-less echo example, and real TTS
back to browser audio. It covered a brief internal pause, barge-in that cleared the old
echo without stale output, disconnect/reconnect, and closure of both sessions and
providers. The microphone track stayed open during ordinary inter-turn silence; no tail
padding or manual per-utterance commits were added.

Those results apply to the upstream implementation and do not claim an additional live
run of this JavaScript port. They do **not** establish access in every resource/region,
recognition accuracy across inputs/languages, every backend tail boundary, long-session
reliability, physical microphone behavior, or subjective voice quality. Hermetic tests
cover client lifecycle and VAD ordering. None of these results is a model-latency
benchmark. An Azure Speech TTS resource/key does **not** establish access to the separate
STT service.

This package follows the repository's synchronized `1.9.1` version.

There is no LLM, speech-to-speech realtime model, Azure OpenAI convenience constructor,
provider catalog, token minting, or OpenAI credential/model default.

The implementation adapts the Apache-2.0-licensed LiveKit OpenAI plugin's package and
STT/TTS interfaces and the Azure plugin's REST transport pattern. It does not depend on
either plugin. Transport, transcription finalization, and escaped SSML/WAV mapping are
specific to this integration. See `NOTICE`.

## Installation

```sh
pnpm add @livekit/agents-plugin-microsoft
```

In this repository, use the workspace package and run `pnpm build` before an example.

## Configuration

Pass constructor options or set the following environment variables. There are
deliberately no default endpoints, models, voice IDs, or TTS sample rate. Obtain these
values and the exact contract from your deployment owner.

| Environment variable           | Constructor option                                      |
| ------------------------------ | ------------------------------------------------------- |
| `MICROSOFT_AI_STT_URL`         | `new STT({ url })`                                      |
| `MICROSOFT_AI_STT_API_KEY`     | `new STT({ apiKey })`                                   |
| `MICROSOFT_AI_STT_AUTH_HEADER` | `new STT({ authHeader })`: `Authorization` or `api-key` |
| `MICROSOFT_AI_STT_MODEL`       | `new STT({ model })`                                    |
| `MICROSOFT_AI_STT_LANGUAGE`    | `new STT({ language })` (optional)                      |
| `MICROSOFT_AI_TTS_URL`         | `new TTS({ url })`                                      |
| `MICROSOFT_AI_TTS_REGION`      | `new TTS({ region })` (when no URL is configured)       |
| `MICROSOFT_AI_TTS_API_KEY`     | `new TTS({ apiKey })`                                   |
| `MICROSOFT_AI_TTS_MODEL`       | `new TTS({ model })`                                    |
| `MICROSOFT_AI_TTS_VOICE`       | `new TTS({ voice })`                                    |
| `MICROSOFT_AI_TTS_SAMPLE_RATE` | `new TTS({ sampleRate })`                               |
| `MICROSOFT_AI_ENV_FILE`        | `new STT({ envFile })`, `new TTS({ envFile })`          |

URLs are complete endpoints, including any required path and query string. For example,
`wss://stt.example.invalid/v1/realtime?intent=transcription` is a **dummy**, not a
Microsoft service address. No path or model query parameter is appended. TLS is required
except for loopback development endpoints. A configured full TTS URL wins over `region`,
regardless of which configuration source provides each. Only when the URL is unset does
an explicitly supplied region select the standard public-cloud endpoint. An explicit or
configured empty/whitespace URL is an error, not permission to fall back to a region.
Other required empty values also fail rather than falling back silently.

TTS sends the Azure Speech resource key as `Ocp-Apim-Subscription-Key`, **not** as a
raw-key Bearer token. STT preserves its `Authorization: Bearer ...` default. For an Azure
realtime endpoint using resource-key authentication, explicitly set
`MICROSOFT_AI_STT_AUTH_HEADER=api-key` or pass `authHeader: 'api-key'`; the raw credential
from `MICROSOFT_AI_STT_API_KEY` is sent as the `api-key` header, without a Bearer prefix.
The selector accepts only exact `Authorization` and `api-key` values. There is no auth
fallback or automatic scheme detection, and credentials are never added to the URL.

Explicit `headers` (including `{}`) override the STT selector and credential environment
settings and cannot be combined with `apiKey` or `authHeader` constructor options. Use
them only for a confirmed alternate authentication scheme. No credentials are read from
OpenAI or Azure variables.

Keep connection information in process environment or a user-selected dotenv file
**outside the checkout** (or deliberately ignored). A file is loaded only when `envFile`
or `MICROSOFT_AI_ENV_FILE` selects one; there is no automatic `.env` discovery, shell
sourcing, interpolation, environment mutation, or value logging. Precedence is constructor
option, process environment, then selected file. An empty required value fails rather
than silently falling back. Use owner-only permissions and never commit the file.

The smoke example additionally accepts `--env-file`. It preflights every selected service
before making a request, so a partial template cannot accidentally start a selected test.
On POSIX, the file must have mode `0600`. Never commit endpoints, credentials, recordings,
transcripts, or request/response captures. Provider errors deliberately omit response
bodies and transport exception details that could expose this information.

## STT contract and lifecycle

For the Azure GA **transcription** endpoint, Microsoft's
[transcription example](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/realtime-audio-websockets#transcribe-audio-in-real-time)
uses `/openai/v1/realtime?intent=transcription`; the deployment name is sent in
`session.audio.input.transcription.model`, not added as a URL query parameter. Configure
the full URL in `MICROSOFT_AI_STT_URL` and deployment in `MICROSOFT_AI_STT_MODEL`. The
plugin sends the URL unchanged; it does not add the conversation API's `model=` query or
preview `deployment`/`api-version` parameters. Do not put a key in the URL. Routing/auth
documentation alone does not establish audio-rate or transcript-event compatibility for
a new deployment; validate the contract below independently.

```ts
import { inference } from '@livekit/agents';
import * as microsoft from '@livekit/agents-plugin-microsoft';

const detector = new inference.VAD({ model: 'silero' });
const speechToText = new microsoft.STT({ vad: detector, language: 'en' });
const textToSpeech = new microsoft.TTS();
```

`vad` is explicit. Pass a LiveKit VAD with ordered inference events even during silence,
input-relative timestamps, and start-of-speech frames containing the detected onset and
prefix through that timestamp (the bundled Silero VAD provides these). Empty or
incompatible start frames fail explicitly rather than clipping onset. Alternatively,
pass `vad: null` and call `flush()` or `endInput()` yourself. **Configuring only
AgentSession's VAD is insufficient:** it does not commit native STT streams.

The client protocol is:

1. Await `session.created`, send `session.update`, then await `session.updated`.
2. Configure transcription with `audio.input.format` equal to
   `{"type":"audio/pcm","rate":16000}`, a required model, optional language,
   `turn_detection: null`, and `noise_reduction: null`.
3. Send base64 PCM16 little-endian mono audio as `input_audio_buffer.append`.
4. For an `item_id`, an `.intermediate` event replaces the revisable hypothesis. A
   `.delta` event appends finalized text and clears the hypothesis. Both produce LiveKit
   interim results, not final utterances.
5. Drain audio, send `input_audio_buffer.commit`, await `input_audio_buffer.committed`
   with `item_id`, then `.completed` with the authoritative `transcript`. Only completion
   emits a LiveKit final transcript followed by end-of-speech. Completion may correct or
   retract earlier hypotheses; an empty completion finishes the item without inventing
   text. The socket remains open for later utterances.

New deployments must implement these event fields and handshake/commit ordering. A short
manual-commit smoke does not exercise every interim revision or VAD boundary. HTTP
statuses are preserved. WebSocket `error` and transcription `.failed` events are terminal
unless a pre-audio transient status is supplied. Initial error mapping recognizes
`error.status_code`, `invalid_api_key`, `rate_limit_exceeded`, `content_filter`, and
`safety_violation`; safety checks are never disabled or bypassed.

VAD inference timestamps serialize audio and turn boundaries so later audio cannot
overtake an earlier commit. Mono input at other rates is resampled by the SDK; stereo is
rejected. Transport frames are 50 ms. Final short frames and resampler/VAD remainder are
sent without rounding away samples or adding synthetic padding.

With VAD, idle windows are discarded locally, not uploaded to an uncommitted server
buffer. At speech start, actual VAD frames restore the complete onset/prefix; there is no
guessed pre-roll duration or dependency on private VAD settings. Only overlap with a
previously committed turn is removed. Prefix is framed and flushed before later audio so
it is not counted twice for backpressure. Speech and observed end-of-speech silence are
uploaded in order and committed; prolonged inter-turn silence sends neither audio nor
empty commits. No provider clear or keepalive event is invented.

**Tail limitation:** sending every byte and receiving `.completed` proves transport
completion, not that the backend decoded an incomplete model chunk. There is no invented
padding rule. Acknowledged completion is authoritative even when it removes an interim
hypothesis. Comparing final and revisable text cannot distinguish legitimate revision
from recognition or tail loss; discarded hypotheses are never appended to final text.
The opt-in fixture smoke must verify the full expected transcript, especially its last
word, for short and non-chunk-aligned clips. Obtain a documented backend drain mechanism
if commit does not decode the tail.

After VAD detects speech, `flush()` drains its real audio tail and commits, waiting before
later input while leaving the socket open. `endInput()` also waits for acknowledged final
completion and closes input. Flushing or ending idle VAD input produces no empty turn. To
send a finite clip regardless of detection, use `vad: null`; manual mode forwards all
input and requires caller-managed commits. `close()` cancels immediately without
committing or exposing buffered events. Batch recognition is unsupported.

`APIConnectOptions.timeoutMs` bounds connection, handshake, writes, and finalization.
`maxRetry` is a finite connection-only budget: after audio is consumed, disconnect/error
is surfaced without replay or hidden reconnection. Reopening the stream is the caller's
decision. Input is bounded by `maxBufferedAudio` (default five seconds) and 1,024 queued
entries; overflow fails explicitly. Each VAD start prefix is separately capped by the
same duration and fails rather than truncating. The adapter keeps no additional idle
history. Idle samples count as processed, so silence does not consume queued-audio
allowance indefinitely. These bounds cover client lag and prefix retention, not active
utterance length at the provider. Pace prerecorded input instead of enqueueing whole
files.

## Azure Speech TTS contract

This implementation follows Microsoft's
[MAI voice documentation](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/mai-voices)
and [Speech REST reference](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/rest-text-to-speech).
It posts SSML to the **exact configured synthesis URL** with
`Content-Type: application/ssml+xml`, `Ocp-Apim-Subscription-Key`,
`X-Microsoft-OutputFormat`, `User-Agent`, and `Accept: audio/wav`.

Supply the full synthesis endpoint, including its documented `cognitiveservices/v1` path
and resource-specific routing. A generic Azure resource or SDK endpoint may not be a
usable REST synthesis URL. The plugin does not append a path, infer a region, rewrite a
host, or follow redirects.

Alternatively, supply `region` or `MICROSOFT_AI_TTS_REGION` without a URL. The plugin
constructs `https://<region>.tts.speech.microsoft.com/cognitiveservices/v1`, following
the public-cloud convention. This is not an availability catalog or access guarantee.
Sovereign clouds and custom/private deployments require an explicit URL. There is no
automatic region detection, failover, or redirection.

The full `voice` ID selects voice and model in SSML. `model` is required metadata and is
checked case-insensitively against the voice ID suffix. For example, public documentation
pairs `mai-voice-2-flash` with `en-US-Harper:MAI-Voice-2-Flash`; availability still
depends on resource and region. **Voice-2.1-Flash and Voice-2-Flash are not aliases.**
SSML language defaults to `en-US`; use `language` for another locale.

Text and attributes are structurally XML-escaped. Input is always plain text, not
caller-provided SSML, and cannot inject `<audio>` or other markup. There are no speaker
tags, `input`/`prompt` JSON, separate JSON voice property, token minting, voice cloning,
safety overrides, or quality-disable controls.

The response must be HTTP 200 with a WAV content type and a complete uncompressed PCM16
mono WAV at the configured rate. Supported documented rates are 8,000, 22,050, 24,000,
44,100, and 48,000 Hz; at 24 kHz the requested format is
`riff-24khz-16bit-mono-pcm`. Empty/truncated audio, incorrect rates/channels, JSON/base64
envelopes, SSE, MP3, and raw PCM are rejected rather than guessed. Unsupported direct
JSON/Foundry variants are not silently attempted as fallbacks.

`TTS.synthesize()` returns a `ChunkedStream` of correctly framed audio only after the
complete response is validated. Native streaming is intentionally unsupported;
AgentSession supplies its sentence `StreamAdapter` for incremental LLM text. Cancellation
closes the request and stops output, including buffered frames.

Client-side safeguards, not advertised provider limits, default to
`maxTextLength: 4096`, `maxAudioBytes: 10485760`, and `requestTimeout: 30000` ms. HTTP
errors and safety refusals remain errors. Only transient failures retry, and incomplete
attempts emit no audio.

## Examples and validation

### Microphone echo without an LLM

`examples/src/microsoft_ai_echo.ts` receives a browser microphone through a real room,
transcribes it, and echoes each completed turn through TTS. It uses
`Agent.onUserTurnCompleted()` and `AgentSession.say()`; `StopResponse` suppresses a model
reply. There is no LLM, manual transcript injection, per-utterance `flush()`, or paid
LiveKit Inference.

The same local Silero VAD is passed to **both** STT and AgentSession; each opens its own
stream. Plugin VAD commits after 500 ms of observed silence. Session VAD detects barge-in
after 200 ms. Echoes are interruptible and are not automatically resumed after false
interruption. Preemptive generation and provider retries are disabled. Do not add backend
padding or promote interim text to hide tail loss.

```sh
pnpm build
node ./examples/src/microsoft_ai_echo.ts dev --log-level=info
```

In the browser, explicitly start the microphone and grant permission. Publish only a
microphone track with the official `livekit-client` SDK and a short-lived room-scoped
token. Set `canPublish: true` and `canPublishSources: ["microphone"]`. Do not grant video,
room admin, or remote-agent control. Enable playback from a user gesture, attach agent
audio, and consume standard `lk.transcription` streams for transient captions. Stop must
release capture and disconnect. Use headphones.

Microphone audio is sent to configured STT and recognized final text to TTS. The example
disables recording and typed input and does not log transcripts. Do not enable audio
dumps, debug transcript logs, telemetry exporters, or browser recording for private
speech. Each room session is limited to three minutes; initial audio readiness is bounded
to ten seconds; providers close when the session ends.

### TTS only in a room

`examples/src/microsoft_ai_tts_room.ts` uses only TTS and `AgentSession.say()`. There is no
LLM, STT, VAD, microphone, text input, or paid LiveKit Inference. It says
`Hello, this is a Microsoft AI voice test.` once after room output has a subscriber,
waits for playback, closes the session/provider, and ends the one-shot job. Retries and
recording are disabled. A fresh job triggers another paid TTS request; do not repeatedly
reconnect just to test playback controls.

The current JavaScript `AgentSession` always installs its standard room session transport;
unlike the upstream Python example, it has no `sessionHost: false` start option. The
example disables text input and does not register application RPC methods, but cannot
claim that the framework transport itself is absent.

```sh
export LIVEKIT_URL=ws://127.0.0.1:7880
export LIVEKIT_API_KEY=devkey
export LIVEKIT_API_SECRET=secret
export MICROSOFT_AI_ENV_FILE=/path/outside/checkout/endpoints.env
pnpm build
node ./examples/src/microsoft_ai_tts_room.ts dev
```

`devkey` and `secret` are public local-server development defaults, not Azure credentials
and not suitable for an exposed server. Connect a subscribe-only participant, invoke
`room.startAudio()` from a click, and attach subscribed audio. Do not give the browser the
Microsoft key, server API secret, or microphone access. Use room `dev` mode, not local
device `console` mode.

### Full STT/LLM/TTS agent

`examples/src/microsoft_ai_agent.ts` combines existing OpenAI LLM, bundled VAD, and this
STT/TTS package. OpenAI credentials are used by the LLM only. The full agent requires STT
and TTS access; an Azure Speech TTS key alone is insufficient. The LLM additionally needs
`OPENAI_API_KEY`. Console mode removes the Cloud requirement, not provider requirements.

```sh
pnpm build
node ./examples/src/microsoft_ai_agent.ts console
```

Set `MICROSOFT_AI_ENV_FILE` first to use an external config file. Keep the LLM key
separate; this plugin does not copy unrelated values into process environment.

### Direct endpoint smoke test

`examples/src/microsoft_ai_smoke.ts` is an explicit-opt-in direct smoke path without
LiveKit Cloud or an LLM. It sends at most one short TTS request and one user-approved
fixture, with no automatic retries, recording, transcript printing, playback, or load
testing. TTS uses the Azure subscription key; STT uses the configured auth selector. The
whole run is bounded to 50 seconds.

```sh
pnpm build
node ./examples/src/microsoft_ai_smoke.ts --help
```

After confirming the TTS endpoint and approving fixed text, opt in to TTS only:

```sh
node ./examples/src/microsoft_ai_smoke.ts --run-live --tts \
  --env-file /path/outside/checkout/endpoints.env
```

Only after separately confirming STT access and protocol, test an approved fixture:

```sh
node ./examples/src/microsoft_ai_smoke.ts --run-live \
  --env-file /path/outside/checkout/endpoints.env \
  --stt-wav /path/outside/checkout/approved-speech.wav \
  --expected-text-file /path/outside/checkout/approved-expected.txt
```

The WAV must be PCM16 mono at 16 kHz, nonempty, and no longer than five seconds. The
script checks complete expected words, ignoring only case and punctuation. It sends no
additional silence and never fabricates final text from an intermediate hypothesis.
Repeat manually with a separately approved non-chunk-aligned clip to check tail handling;
one clip is not a universal guarantee. `--tts` sends only the fixed sentence shown above.
Reported elapsed time covers the client call through stream closure, not model TTFA,
because audio is emitted only after complete WAV validation.

Validate each service independently for a new deployment: confirm URLs, credentials and
auth transport, model/voice IDs, and event/request/response schemas. Successful Azure
Speech TTS validation does not validate STT or backend audio-tail finalization.
