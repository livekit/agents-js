<!--
SPDX-FileCopyrightText: 2026 LiveKit, Inc.

SPDX-License-Identifier: Apache-2.0
-->
# Fish Audio plugin for LiveKit Agents

The Agents Framework is designed for building realtime, programmable
participants that run on servers. Use it to create conversational, multi-modal
voice agents that can see, hear, and understand.

This package contains the Fish Audio plugin, which allows for voice synthesis.
Refer to the [Fish Audio documentation](https://docs.fish.audio) for
information on how to use it.

The plugin uses the Fish Audio Live TTS WebSocket API for streaming synthesis,
and the HTTP `/v1/tts` endpoint for one-shot synthesis. Output is delivered as
raw 16-bit little-endian PCM (24 kHz by default).

See the [repository](https://github.com/livekit/agents-js) for more information
about the framework as a whole.
