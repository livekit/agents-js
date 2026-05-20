# @livekit/agents-plugin-anthropic

Anthropic plugin for LiveKit Node Agents.

## Installation

```bash
npm install @livekit/agents-plugin-anthropic
```

## Usage

```typescript
import { anthropic } from '@livekit/agents-plugin-anthropic';

const agent = new Agent({
  llm: new anthropic.LLM({
    model: 'claude-3-5-sonnet-20241022',
    // caching: 'ephemeral' // uncomment to enable prompt caching
  }),
});
```
