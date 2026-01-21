# Hedra plugin for LiveKit Agents

Support for avatar generation and animation with [Hedra](https://hedra.ai/).

See [https://docs.livekit.io/agents/integrations/avatar/hedra/](https://docs.livekit.io/agents/integrations/avatar/hedra/) for more information.

## Installation

```bash
npm install @livekit/agents-plugin-hedra
# or
pnpm add @livekit/agents-plugin-hedra
# or
yarn add @livekit/agents-plugin-hedra
```

## Pre-requisites

You'll need an API key from Hedra. It can be set as an environment variable: `HEDRA_API_KEY`

## Usage

### Using an Avatar ID

```typescript
import { AvatarSession } from '@livekit/agents-plugin-hedra';

// Create an avatar session with an avatar ID
const avatar = new AvatarSession({
  avatarId: 'your-avatar-id',
  apiKey: 'your-hedra-api-key', // or set HEDRA_API_KEY env var
});

// Start the avatar session after creating your agent session
await avatar.start(agentSession, room);
```

### Using a Custom Avatar Image

```typescript
import { AvatarSession } from '@livekit/agents-plugin-hedra';
import fs from 'node:fs';

// Read an image file
const imageBuffer = fs.readFileSync('path/to/avatar.jpg');

// Create an avatar session with a custom image
const avatar = new AvatarSession({
  avatarImage: {
    data: imageBuffer,
    mimeType: 'image/jpeg',
    filename: 'avatar.jpg',
  },
  apiKey: 'your-hedra-api-key',
});

// Start the avatar session
await avatar.start(agentSession, room);
```

### Full Example

```typescript
import {
  type JobContext,
  type JobProcess,
  WorkerOptions,
  cli,
  defineAgent,
  voice,
} from '@livekit/agents';
import * as deepgram from '@livekit/agents-plugin-deepgram';
import * as hedra from '@livekit/agents-plugin-hedra';
import * as openai from '@livekit/agents-plugin-openai';
import * as silero from '@livekit/agents-plugin-silero';

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load();
  },
  entry: async (ctx: JobContext) => {
    const vad = ctx.proc.userData.vad as silero.VAD;

    const assistant = new voice.Agent({
      instructions: 'You are a helpful voice AI assistant.',
    });

    const session = new voice.AgentSession({
      vad,
      stt: new deepgram.STT(),
      llm: new openai.LLM(),
      tts: new openai.TTS(),
    });

    // Create and start the Hedra avatar
    const avatar = new hedra.AvatarSession({
      avatarId: 'your-avatar-id',
    });

    await session.start({
      agent: assistant,
      room: ctx.room,
    });

    // Start the avatar session after connecting
    await avatar.start(session, ctx.room);

    session.generateReply({
      instructions: 'Greet the user and offer your assistance.',
    });
  },
});
```

## Configuration Options

### AvatarSessionOptions

| Option | Type | Description |
|--------|------|-------------|
| `avatarId` | `string` | The Hedra avatar ID to use. Either `avatarId` or `avatarImage` must be provided. |
| `avatarImage` | `AvatarImage` | A custom avatar image. Either `avatarId` or `avatarImage` must be provided. |
| `apiUrl` | `string` | The Hedra API URL. Defaults to `HEDRA_API_URL` env var or the default Hedra API endpoint. |
| `apiKey` | `string` | The Hedra API key. Defaults to `HEDRA_API_KEY` env var. |
| `avatarParticipantIdentity` | `string` | The identity of the avatar participant in the room. Defaults to `'hedra-avatar-agent'`. |
| `avatarParticipantName` | `string` | The name of the avatar participant in the room. Defaults to `'hedra-avatar-agent'`. |
| `connOptions` | `APIConnectOptions` | Connection options for API requests (retry count, timeout, etc.). |

### AvatarImage

| Property | Type | Description |
|----------|------|-------------|
| `data` | `Buffer` | The raw image data. |
| `mimeType` | `string` | The MIME type of the image (e.g., `'image/jpeg'`, `'image/png'`). |
| `filename` | `string` | Optional filename for the image. |

## Environment Variables

| Variable | Description |
|----------|-------------|
| `HEDRA_API_KEY` | Your Hedra API key |
| `HEDRA_API_URL` | Custom Hedra API URL (optional) |
| `LIVEKIT_URL` | Your LiveKit server URL |
| `LIVEKIT_API_KEY` | Your LiveKit API key |
| `LIVEKIT_API_SECRET` | Your LiveKit API secret |
