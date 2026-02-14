# LemonSlice plugin for LiveKit Agents

Support for avatar generation and animation with [LemonSlice](https://lemonslice.com/).

See [https://docs.livekit.io/agents/models/avatar/plugins/lemonslice/](https://docs.livekit.io/agents/models/avatar/plugins/lemonslice/) for more information.

## Installation

```bash
npm install @livekit/agents-plugin-lemonslice
# or
pnpm add @livekit/agents-plugin-lemonslice
# or
yarn add @livekit/agents-plugin-lemonslice
```

## Pre-requisites

You'll need an API key from LemonSlice. It can be set as an environment variable: `LEMONSLICE_API_KEY`
Manage your LemonSlice API key through the [LemonSlice API Dashboard](https://lemonslice.com/agents/api)

## Usage

```typescript
import { AvatarSession } from '@livekit/agents-plugin-lemonslice';

// Create an avatar session with an image URL
const avatar = new AvatarSession({
  agentImageUrl: 'publicly-accessible-image-url',
  apiKey: 'your-lemonslice-api-key', // or set LEMONSLICE_API_KEY env var
});

// Start the avatar session after creating your agent session
await avatar.start(agentSession, room);
```

### Full Example

Find a complete working example [here](../../examples/src/lemonslice_realtime_avatar.ts).

Set `LEMONSLICE_API_KEY` and `LEMONSLICE_IMAGE_URL` to get up and running.


## Configuration Options

### AvatarSessionOptions

| Option | Type | Description |
|--------|------|-------------|
| `agentId` | `string` | The LemonSlice agent ID to use. Either `agentId` or `agentImageUrl` must be provided. |
| `agentImageUrl` | `AvatarImage` | A publicly accessible url to your avatar image. Either `agentId` or `agentImageUrl` must be provided. |
| `apiUrl` | `string` | The LemonSlice API URL. Defaults to `LEMONSLICE_API_URL` env var or the default LemonSlice API endpoint. |
| `apiKey` | `string` | The LemonSlice API key. Defaults to `LEMONSLICE_API_KEY` env var. |
| `avatarParticipantIdentity` | `string` | The identity of the avatar participant in the room. Defaults to `'lemonslice-avatar-agent'`. |
| `avatarParticipantName` | `string` | The name of the avatar participant in the room. Defaults to `'lemonslice-avatar-agent'`. |
| `connOptions` | `APIConnectOptions` | Connection options for API requests (retry count, timeout, etc.). |

## Environment Variables

| Variable | Description |
|----------|-------------|
| `LEMONSLICE_API_KEY` | Your LemonSlice API key |
| `LEMONSLICE_API_URL` | Custom LemonSlice API URL (optional) |
| `LIVEKIT_URL` | Your LiveKit server URL |
| `LIVEKIT_API_KEY` | Your LiveKit API key |
| `LIVEKIT_API_SECRET` | Your LiveKit API secret |
