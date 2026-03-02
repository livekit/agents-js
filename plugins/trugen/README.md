<!--
SPDX-FileCopyrightText: 2026 LiveKit, Inc.

SPDX-License-Identifier: Apache-2.0
-->

# Trugen plugin for LiveKit Agents

Support for [Trugen](https://trugen.ai) realtime avatars.

See [https://docs.trugen.ai](https://docs.trugen.ai) for more information.

## Installation

```bash
npm install @livekit/agent-plugin-trugen
```

or

```bash
pnpm add @livekit/agent-plugin-trugen
```

## Pre-requisites

Create a developer API key from the [Trugen dashboard](https://app.trugen.ai) and set the `TRUGEN_API_KEY` environment variable with it:

```bash
export TRUGEN_API_KEY=<your-trugen-api-key>
```

## Usage

```typescript
import { AvatarSession } from '@livekit/agent-plugin-trugen';
                                                                                                                                                 
  // inside your existing defineAgent entry function:                                                                                            

  const avatarSession = new AvatarSession({
    avatarId: process.env.TRUGEN_AVATAR_ID, // optional
    apiKey: process.env.TRUGEN_API_KEY,
  });

  // must be called BEFORE agentSession.start()
  await avatarSession.start(agentSession, room, {
    livekitUrl: process.env.LIVEKIT_URL,
    livekitApiKey: process.env.LIVEKIT_API_KEY,
    livekitApiSecret: process.env.LIVEKIT_API_SECRET,
  });
```

## API

### `AvatarSession`

Creates a new Trugen avatar session.

#### Constructor Options

- `avatarId?: string | null` - The avatar ID to use. Defaults to stock avatar.
- `apiUrl?: string` - The Trugen API URL. Can also be set via `TRUGEN_API_URL` environment variable. Defaults to `https://api.trugen.ai`.
- `apiKey?: string` - Your Trugen API key. Can also be set via `TRUGEN_API_KEY` environment variable.
- `avatarParticipantIdentity?: string` - The identity for the avatar participant. Defaults to `'trugen-avatar'`.
- `avatarParticipantName?: string` - The name for the avatar participant. Defaults to `'Trugen Avatar'`.
- `connOptions?: APIConnectOptions` - Connection options for retry logic.

#### Methods

##### `start(agentSession: voice.AgentSession, room: Room, options?: StartOptions): Promise<void>`

Starts the avatar session and connects it to the room.

**Options:**
- `livekitUrl?: string` - The LiveKit server URL. Can also be set via `LIVEKIT_URL` environment variable.
- `livekitApiKey?: string` - Your LiveKit API key. Can also be set via `LIVEKIT_API_KEY` environment variable.
- `livekitApiSecret?: string` - Your LiveKit API secret. Can also be set via `LIVEKIT_API_SECRET` environment variable.

## License

Apache 2.0
