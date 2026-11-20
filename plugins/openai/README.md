<!--
SPDX-FileCopyrightText: 2024 LiveKit, Inc.

SPDX-License-Identifier: Apache-2.0
-->

# OpenAI plugin for LiveKit Agents

The Agents Framework is designed for building realtime, programmable
participants that run on servers. Use it to create conversational, multi-modal
voice agents that can see, hear, and understand.

This package contains the OpenAI plugin, which allows for TTS, STT, LLM, as well
as using the Realtime API and Responses API. Refer to the
[documentation](https://docs.livekit.io/agents/overview/) for information on how
to use it, or browse the [API
reference](https://docs.livekit.io/agents-js/modules/plugins_agents_plugin_openai.html).
See the [repository](https://github.com/livekit/agents-js) for more information
about the framework as a whole.

## OpenAI-compatible model options

Use `modelOptions` on the Chat Completions `LLM` or its provider helpers to
configure provider-specific request fields for every agent turn:

```typescript
import { LLM } from '@livekit/agents-plugin-openai';

const model = LLM.withTelnyx({
  model: 'moonshotai/Kimi-K2.6',
  modelOptions: { enable_thinking: false },
});
```

Per-call `chat({ chatCtx, extraKwargs })` values override matching `modelOptions`
keys. Existing typed options such as `topP` and `toolChoice` are applied afterward.
The constructor snapshots the top-level defaults, and each request creates a
fresh shallow merge; nested objects are replaced rather than deep merged.
The shared serializer retains its existing behavior, including applying
`extra_body` after other request fields.
