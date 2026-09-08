<!--
SPDX-FileCopyrightText: 2024 LiveKit, Inc.

SPDX-License-Identifier: Apache-2.0
-->
# Rime plugin for LiveKit Agents

The Agents Framework is designed for building realtime, programmable
participants that run on servers. Use it to create conversational, multi-modal
voice agents that can see, hear, and understand.

This package contains the Rime plugin, which provides high-quality text-to-speech (TTS) capabilities for voice synthesis. Refer to the
[documentation](https://docs.livekit.io/agents/overview/) for information on how to use it,
or browse the [API reference](https://docs.livekit.io/agents-js/modules/plugins_agents_plugin_rime.html).
See the [repository](https://github.com/livekit/agents-js) for more information
about the framework as a whole.

## WebSocket v1 streaming

Set `RIME_API_KEY` and pass the model endpoint in `websocketURL`:

```ts
import { TTS } from '@livekit/agents-plugin-rime';

const rime = new TTS({
  websocketURL: 'wss://api.rime.ai/coda/ws',
  speaker: 'astra',
});
```

The endpoint selects the model. Do not pass `modelId` for a route such as
`/coda/ws` or `/mist/ws`. For a dedicated endpoint ending in `/ws`, pass `modelId`.
The default speaker is `astra` for Coda and `cove` for Mist. The public v1 endpoint
currently supports Coda. The Mist route is `/mist/ws`.

`websocketProtocol` defaults to `binary`, with the `rime.v1.binary` subprotocol.
Set it to `json` for `rime.v1.json` and canonical protobuf JSON. Both modes use
the generated definitions from `@rimelabs/api@0.0.1`.

One stream uses one continuous synthesis context. Text fragments pass through a
LiveKit sentence tokenizer before transmission. The default tokenizer emits one
sentence at a time. A custom `tokenizer` must emit complete, stable sentence units.

| Stream method | Behavior |
| --- | --- |
| `pushText(text)` | Buffer text and send complete sentences. |
| `flush()` | Release buffered text locally. Keep the context open. |
| `endInput()` | Send remaining text, then `end`. Wait for `done`. |
| `close()` | Stop synthesis and send `cancel` when a context is active. |

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
