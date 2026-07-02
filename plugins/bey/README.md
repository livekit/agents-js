<!--
SPDX-FileCopyrightText: 2025 LiveKit, Inc.

SPDX-License-Identifier: Apache-2.0
-->

# Beyond Presence plugin for LiveKit Agents

Support for [Beyond Presence](https://docs.bey.dev) virtual avatars.

See [https://docs.livekit.io/agents/integrations/avatar/bey/](https://docs.livekit.io/agents/integrations/avatar/bey/) for more information.

## Installation

```bash
npm install @livekit/agents-plugin-bey
```

or

```bash
pnpm add @livekit/agents-plugin-bey
```

## Pre-requisites

Create a developer API key from the [creator dashboard](https://app.bey.chat) and set the `BEY_API_KEY` environment variable with it:

```bash
export BEY_API_KEY=<your-bey-api-key>
```

## Usage

```typescript
import { AvatarSession } from '@livekit/agents-plugin-bey';
import { AgentSession } from '@livekit/agents';

// Create an avatar session
const avatarSession = new AvatarSession({
  avatarId: 'your-avatar-id', // optional, defaults to stock avatar
  apiKey: process.env.BEY_API_KEY, // optional if set via env var
});

// Start the avatar in your agent
await avatarSession.start(agentSession, room, {
  livekitUrl: process.env.LIVEKIT_URL,
  livekitApiKey: process.env.LIVEKIT_API_KEY,
  livekitApiSecret: process.env.LIVEKIT_API_SECRET,
});
```

## API

### `AvatarSession`

Creates a new Beyond Presence avatar session.

#### Constructor Options

- `avatarId?: string` - The avatar ID to use. Defaults to stock avatar.
- `apiUrl?: string` - The Bey API URL. Defaults to `https://api.bey.dev`.
- `apiKey?: string` - Your Bey API key. Can also be set via `BEY_API_KEY` environment variable.
- `avatarParticipantIdentity?: string` - The identity for the avatar participant. Defaults to `'bey-avatar-agent'`.
- `avatarParticipantName?: string` - The name for the avatar participant. Defaults to `'bey-avatar-agent'`.
- `connOptions?: APIConnectOptions` - Connection options for retry logic.

#### Methods

##### `start(agentSession: AgentSession, room: Room, options?: StartOptions): Promise<void>`

Starts the avatar session and connects it to the room.

**Options:**
- `livekitUrl?: string` - The LiveKit server URL. Can also be set via `LIVEKIT_URL` environment variable.
- `livekitApiKey?: string` - Your LiveKit API key. Can also be set via `LIVEKIT_API_KEY` environment variable.
- `livekitApiSecret?: string` - Your LiveKit API secret. Can also be set via `LIVEKIT_API_SECRET` environment variable.

## License

Apache 2.0
