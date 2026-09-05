<!--
SPDX-FileCopyrightText: 2026 LiveKit, Inc.

SPDX-License-Identifier: Apache-2.0
-->

# MiniMax plugin for LiveKit Agents

The Agents Framework is designed for building realtime, programmable
participants that run on servers. Use it to create conversational, multi-modal
voice agents that can see, hear, and understand.

This package contains the MiniMax plugin, which provides chat completion and
text-to-speech integrations. Chat completion supports the global and China
OpenAI-compatible and Anthropic-compatible APIs.

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
`MINIMAX_API_KEY`. For text-to-speech, you can also override the API endpoint via
`MINIMAX_BASE_URL` (defaults to `https://api-uw.minimax.io`). Chat completion
endpoints are selected with the `region` or `baseURL` option.

## Chat completion

The OpenAI-compatible API is used by default:

```ts
import { LLM } from '@livekit/agents-plugin-minimax';

const model = new LLM({
  region: 'global_en',
  thinking: 'adaptive',
});
```

Use `AnthropicLLM` for the Anthropic-compatible API, and set `region: 'cn_zh'`
to select the China endpoint.
