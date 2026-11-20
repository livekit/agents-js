# @livekit/agents-plugin-anthropic

Anthropic plugin for LiveKit Node Agents.

## Installation

```bash
npm install @livekit/agents-plugin-anthropic
```

## Usage

```typescript
import * as anthropic from '@livekit/agents-plugin-anthropic';

const session = new voice.AgentSession({
  llm: new anthropic.LLM({
    model: 'claude-sonnet-4-6',
  }),
});
```

## Web search

Use Anthropic's hosted search alongside the agent's function tools:

```typescript
import { voice } from '@livekit/agents';
import * as anthropic from '@livekit/agents-plugin-anthropic';

const agent = new voice.Agent({
  instructions: 'Use web search for questions requiring current information.',
  tools: [new anthropic.WebSearch({ maxUses: 3 })],
});
```

`WebSearch` uses `web_search_20250305`. It accepts `maxUses`, `allowedDomains`,
`blockedDomains`, and `userLocation`. Domain allowlists and blocklists cannot be combined.
Search execution stays on Anthropic's servers.

Search results and citations are emitted as they arrive and exposed as `AnthropicResponseData` in
`ChatChunk.delta.extra.anthropic`, and preserved in the assistant chat message's `extra.anthropic`.
Pending searches in turns containing function calls are preserved on those calls instead.
When managing chat history yourself, retain the collected response's `extra` on the assistant
message and retain function calls with their `extra` data. This keeps encrypted search content
and citation references available for subsequent requests.

Voice transcript persistence requires a forwarded assistant message or a function call. A terminal
response containing only search metadata remains available to stream/collect callers but does not
create an empty assistant transcript message.

The plugin resumes `pause_turn` responses with the original content and tools, up to five API
requests per generation. It reports an error if the turn remains paused at that limit.
