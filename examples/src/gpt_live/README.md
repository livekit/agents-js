<!--
SPDX-FileCopyrightText: 2026 LiveKit, Inc.

SPDX-License-Identifier: Apache-2.0
-->

# GPT-Live

Two examples for the OpenAI GPT-Live full-duplex voice model (v3 alpha).
An OpenAI key with GPT-Live access is required. Set `OPENAI_API_KEY`, `LIVEKIT_URL`,
`LIVEKIT_API_KEY`, and `LIVEKIT_API_SECRET` in `examples/.env`.

From the repository root:

```bash
pnpm build
pnpm --filter livekit-agents-examples exec tsx --env-file=.env src/gpt_live/gpt_live_agent.ts dev
pnpm --filter livekit-agents-examples exec tsx --env-file=.env src/gpt_live/client_delegation.ts dev
```

GPT-Live listens and speaks at the same time. It delegates reasoning and tool work.
The delegation mode is fixed when the session starts.

| Example                | Delegation            | Who does the work              |
| ---------------------- | --------------------- | ------------------------------ |
| `gpt_live_agent.ts`    | `responses` (default) | A backend Responses model      |
| `client_delegation.ts` | `client`              | An LLM running in your process |

## Responses delegation

The backend calls the agent's function tools through the framework. `responsesOptions`
selects its model and instructions, separate from the voice persona. The example seeds a
prior conversation and includes OpenAI's hosted `WebSearch` tool. The order and weather
functions return sample data; they do not contact external services.

Startup history keeps the newest 128 rendered messages. The service enforces its 8192-token
startup limit and 500-token append limit. The plugin has no tokenizer for these limits.
Instructions and history cannot be replaced after startup. Use `appendInstructions` for
standing rules, `appendThinking` for silent context, and `appendCommentary` for text to say.

## Client delegation

The voice agent has no tools. Registering tools in this mode raises `RealtimeError`.
The `delegation_created` event supplies an id and `pendingTranscript`, which contains the
caller's words that may not yet be in the agent's chat context.

The handler starts an independent task. An ordinary inference LLM uses the tools in
`tools.ts` and returns its answer through `appendCommentary(answer, { delegationId })`.
The voice model says that answer in its own words. Tasks are canceled when the agent exits.

Each delegation has its own history snapshot. A later request cannot supersede an earlier
one: a correction from Monday to Tuesday can cause both tasks to answer. Applications that
need cancellation across requests must coordinate a shared conversation.
