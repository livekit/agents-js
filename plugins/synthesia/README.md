# Synthesia plugin for LiveKit Agents

Attach a [Synthesia](https://www.synthesia.io/) interactive avatar to a LiveKit voice agent. The avatar joins the room and lip-syncs the agent's speech in real time.

See the [Synthesia integration docs](https://docs.livekit.io/agents/models/avatar/plugins/synthesia/) for more information.

## Installation

```bash
npm install @livekit/agents-plugin-synthesia
```

## Pre-requisites

You'll need an API key from Synthesia. It can be set as the `SYNTHESIA_API_KEY` environment variable.

## Usage

```typescript
import { voice } from '@livekit/agents';
import * as synthesia from '@livekit/agents-plugin-synthesia';

const session = new voice.AgentSession(/* ... */);
const avatar = new synthesia.AvatarSession(
  new synthesia.AvatarConfig({
    avatarIds: ['03cee7ec-ac90-45ec-8c20-74a399cf3dc4'],
  }),
);

await avatar.start(session, ctx.room); // before session.start()
await session.start({ agent: new Agent(/* ... */), room: ctx.room });
```

Set your Synthesia workspace API key in `SYNTHESIA_API_KEY`, or pass `apiKey`. `avatarIds` takes one to five gallery IDs available to your workspace. The first is active and the rest are precomputed so `swapAvatar()` can switch to them during the session. An inaccessible ID raises `SynthesiaError` with `type` set to `ErrorType.UNKNOWN_AVATAR`.

```typescript
await avatar.swapAvatar('<another-id-from-avatarIds>');
await avatar.swapAvatar('default');
```

## Faster first words

By default, `start()` returns once the avatar has joined the room, so the agent's greeting is only generated after the session request completes. Set `waitForAvatar` to `false` to return immediately and launch the avatar in the background. The greeting is generated while the avatar starts, held until the avatar's video is up, and spoken as soon as it is.

```typescript
await avatar.start(session, ctx.room, { waitForAvatar: false });
await session.start({ agent: new Agent(/* ... */), room: ctx.room });
session.generateReply({ instructions: 'Greet the user.' });

await avatar.waitUntilReady(); // optional: raises SynthesiaError if the avatar failed to start
```

With `waitForAvatar: false`, a failed launch no longer rejects `start()`. It closes the avatar session, is logged, and is raised by `waitUntilReady()`. The agent's audio may remain routed to the avatar until the session ends, so its speech won't be heard: end or restart the session when `waitUntilReady()` rejects.

## Parameters

| Parameter                   | Default                    | Description                                                                                     |
| --------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------- |
| `avatarParticipantIdentity` | `"synthesia-avatar-agent"` | The LiveKit identity the avatar joins under. It must be unique per concurrent avatar in a room. |
| `avatarParticipantName`     | `"Synthesia avatar"`       | The LiveKit display name the avatar joins under.                                                |
