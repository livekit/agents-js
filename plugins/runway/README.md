<!--
SPDX-FileCopyrightText: 2026 LiveKit, Inc.

SPDX-License-Identifier: Apache-2.0
-->

# Runway plugin for LiveKit Agents

Support for [Runway](https://runwayml.com) real-time avatars.

## Installation

```bash
npm install @livekit/agents-plugin-runway
```

## Pre-requisites

Set the `RUNWAYML_API_SECRET` environment variable with your Runway API secret:

```bash
export RUNWAYML_API_SECRET=<your-runway-api-secret>
```

## Usage

```typescript
import { AvatarSession } from '@livekit/agents-plugin-runway';

const avatarSession = new AvatarSession({
  presetId: 'your-avatar-preset-id',
  // apiKey defaults to RUNWAYML_API_SECRET env var
});

await avatarSession.start(agentSession, room);
```

## License

Apache 2.0
