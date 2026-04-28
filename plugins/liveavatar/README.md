<!--
SPDX-FileCopyrightText: 2026 LiveKit, Inc.

SPDX-License-Identifier: Apache-2.0
-->

# LiveAvatar plugin for LiveKit Agents

Support for [LiveAvatar](https://www.liveavatar.com) interactive avatars.

This is the JS/TS port of the Python `livekit-plugins-liveavatar` plugin. See [https://docs.livekit.io/agents/models/avatar/plugins/liveavatar/](https://docs.livekit.io/agents/models/avatar/plugins/liveavatar/) for more information.

## Installation

```bash
npm install @livekit/agents-plugin-liveavatar
```

or

```bash
pnpm add @livekit/agents-plugin-liveavatar
```

## Pre-requisites

Create a developer API key from the LiveAvatar dashboard and set the `LIVEAVATAR_API_KEY` environment variable with it:

```bash
export LIVEAVATAR_API_KEY=<your-liveavatar-api-key>
```

## Usage

```typescript
import { AvatarSession } from '@livekit/agents-plugin-liveavatar';
import { AgentSession } from '@livekit/agents';

const avatarSession = new AvatarSession({
  avatarId: 'your-avatar-id', // or via LIVEAVATAR_AVATAR_ID
  apiKey: process.env.LIVEAVATAR_API_KEY,
  videoQuality: 'high', // optional: 'very_high' | 'high' | 'medium' | 'low'
});

await avatarSession.start(agentSession, room, {
  livekitUrl: process.env.LIVEKIT_URL,
  livekitApiKey: process.env.LIVEKIT_API_KEY,
  livekitApiSecret: process.env.LIVEKIT_API_SECRET,
});
```

## API

### `AvatarSession`

#### Constructor Options

- `avatarId?: string` — The LiveAvatar avatar id. Falls back to `LIVEAVATAR_AVATAR_ID`.
- `apiUrl?: string` — Override the LiveAvatar API base URL.
- `apiKey?: string` — Your LiveAvatar API key. Falls back to `LIVEAVATAR_API_KEY`.
- `isSandbox?: boolean` — Use the LiveAvatar sandbox (1 minute connection limit). Defaults to `false`.
- `videoQuality?: 'very_high' | 'high' | 'medium' | 'low'` — Avatar video quality requested from the service. When omitted, the LiveAvatar service decides.
- `avatarParticipantIdentity?: string` — Identity for the avatar participant. Defaults to `'liveavatar-avatar-agent'`.
- `avatarParticipantName?: string` — Display name for the avatar participant. Defaults to `'liveavatar-avatar-agent'`.
- `connOptions?: APIConnectOptions` — API retry/timeout options.

#### Methods

##### `start(agentSession, room, options?)`

Starts the avatar session, brings up a LiveAvatar streaming session, opens the realtime websocket, and routes the agent's audio output through to the avatar.

**StartOptions:**

- `livekitUrl?: string` — Falls back to `LIVEKIT_URL`.
- `livekitApiKey?: string` — Falls back to `LIVEKIT_API_KEY`.
- `livekitApiSecret?: string` — Falls back to `LIVEKIT_API_SECRET`.

## License

Apache 2.0
