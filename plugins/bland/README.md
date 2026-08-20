<!--
SPDX-FileCopyrightText: 2026 LiveKit, Inc.

SPDX-License-Identifier: Apache-2.0
-->

# Bland plugin for LiveKit Agents

The Agents Framework is designed for building realtime, programmable participants that run on
servers. Use it to create conversational, multi-modal voice agents that can see, hear, and
understand.

This package contains the Bland plugin, which provides text-to-speech capabilities for voice
synthesis. Refer to the [documentation](https://docs.livekit.io/agents/overview/) for information
on how to use it, or browse the
[API reference](https://docs.livekit.io/agents-js/modules/plugins_agents_plugin_bland.html).
See the [repository](https://github.com/livekit/agents-js) for more information about the framework
as a whole.

Install the package with `pnpm add @livekit/agents-plugin-bland` and set `BLAND_API_KEY` to your
Bland API key.

Voice agents stream text through Bland's realtime WebSocket by default, allowing audio to begin
before the full sentence is available and supporting in-place cancellation on barge-in. The
`synthesize()` method always sends complete strings over HTTP. Set `streaming: false` to disable
WebSocket sessions and use HTTP-only synthesis without holding a Bland concurrency slot.

See the [Bland realtime TTS reference](https://docs.bland.ai/api-v2/post/tts-ws) for protocol
details.
