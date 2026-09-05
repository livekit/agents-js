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

## WebSocket sentence streaming and reuse

For `segment: 'never'`, sentence flushing and connection reuse are opt-in:

```ts
const speech = new rime.TTS({
  modelId: 'coda',
  speaker: 'lyra',
  useWebsocket: true,
  segment: 'never',
  flushSentences: true,
  reuseWebsocket: true,
});
```

`flushSentences` sends each sentence emitted by the configured tokenizer and
waits for that synthesis batch's `done` event before sending the next sentence.
This prevents overlapping flushes from being combined by Rime. Explicit SDK
`stream.flush()` calls still finish separate audio segments and metrics;
whitespace-only segments are ignored. The
tokenizer retains control over when text is ready; this option does not bypass
its buffering or alter its sentence boundaries.

`reuseWebsocket` retains at most one successfully completed connection per TTS
instance for up to 30 idle seconds. Simultaneous streams use separate sockets.
Interrupted or failed streams discard their connections; voice, language, or
other connection-option changes prevent reuse of the old connection. Call
`await speech.close()` during application shutdown to release active and idle
connections and cancel pending connections.

Both options default to `false`; existing HTTP and WebSocket behavior is unchanged
unless enabled. See the [Rime WebSocket segmentation contract](https://docs.rime.ai/docs/websockets-segment)
for provider flush and completion semantics.
