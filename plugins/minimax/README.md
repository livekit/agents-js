<!--
SPDX-FileCopyrightText: 2026 LiveKit, Inc.

SPDX-License-Identifier: Apache-2.0
-->
# MiniMax plugin for LiveKit Agents

The Agents Framework is designed for building realtime, programmable
participants that run on servers. Use it to create conversational, multi-modal
voice agents that can see, hear, and understand.

This package contains the MiniMax plugin, which provides text-to-speech via
MiniMax's `t2a_v2` APIs (both HTTP streaming and WebSocket streaming).

Refer to the [documentation](https://docs.livekit.io/agents/overview/) for
information on how to use it. See the
[repository](https://github.com/livekit/agents-js) for more information about
the framework as a whole.

## Installation

```bash
pnpm add @livekit/agents-plugin-minimax
```

## Pre-requisites

You'll need an API key from MiniMax. It can be set as an environment variable:
`MINIMAX_API_KEY`. You can also override the API endpoint via `MINIMAX_BASE_URL`
(defaults to `https://api-uw.minimax.io`).
