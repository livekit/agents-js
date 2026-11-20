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

## Responses web-search sources

The HTTP and WebSocket Responses LLMs expose completed `web_search_call` items
and messages containing annotations through `ChatChunk.delta.extra.openai.output`.
The items retain OpenAI's original structure, including message IDs, citation
spans in `message.content[].annotations`, and search status and query details.
Each metadata chunk contains the accumulated items for that response, so they
also remain available after `LLMStream.collect()` and in the assistant
`ChatMessage.extra.openai.output` in the session history.

To request the full list of consulted sources, configure the LLM with `include`.
This also works when using the LLM in an `AgentSession`:

```ts
const model = new openai.responses.LLM({
  model: 'gpt-5.6',
  include: ['web_search_call.action.sources'],
});
const result = await model
  .chat({
    chatCtx,
    toolCtx: [new openai.WebSearch()],
  })
  .collect();
console.dir(result.extra.openai, { depth: null });
```

A per-call `extraKwargs.include` overrides the constructor setting.
Full sources, when returned by OpenAI,
are under each search item's `action.sources`. Citations arrive when their
message's output item completes. Citation offsets are relative to the text part
containing the annotation, rather than the concatenated text of the response.
