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
