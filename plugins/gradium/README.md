# LiveKit Agents Plugin Gradium

Gradium STT plugin for LiveKit Agents for Node.js.

## Installation

```bash
pnpm add @livekit/agents-plugin-gradium
```

## Usage

```ts
import * as gradium from '@livekit/agents-plugin-gradium';

const stt = new gradium.STT({
  apiKey: process.env.GRADIUM_API_KEY,
  language: 'en',
});
```
