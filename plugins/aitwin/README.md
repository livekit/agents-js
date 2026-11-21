<!--
SPDX-FileCopyrightText: 2026 LiveKit, Inc.

SPDX-License-Identifier: Apache-2.0
-->
# Ai Twin plugin for LiveKit Agents

Publish assistant reply text on a LiveKit text stream so the browser can call
[`@streamoji/aitwin`](https://www.npmjs.com/package/@streamoji/aitwin)
`speakText()` for TTS + lipsync.

Unlike Anam / Bey / Protoface-style avatars, Ai Twin does **not** join a remote
avatar participant or publish a video track. The agent should run with
**no TTS** and `outputOptions: { audioEnabled: false }`.

## Installation

```bash
npm install @livekit/agents-plugin-aitwin @livekit/agents @livekit/rtc-node
```

## Usage

```ts
import { voice } from '@livekit/agents';
import { AiTwinSpeech } from '@livekit/agents-plugin-aitwin';

const session = new voice.AgentSession({
  vad,
  stt,
  llm,
  // omit TTS — Ai Twin speaks in the browser
});

const twinSpeech = new AiTwinSpeech({ topic: 'aitwin.speak' });
twinSpeech.start(session, ctx.room);

await session.start({
  agent,
  room: ctx.room,
  outputOptions: {
    audioEnabled: false,
    transcriptionEnabled: false,
  },
});
```

In the browser, register a text-stream handler for `aitwin.speak` and call
`speakText()`. See the [Ai Twin LiveKit docs](https://aitwin.me/docs/livekit)
and the reference demo at
[aitwin-me/aitwin-livekit-demo](https://github.com/aitwin-me/aitwin-livekit-demo).

### Auth helper

```ts
import { mintAiTwinAuthToken } from '@livekit/agents-plugin-aitwin';

const { authToken } = await mintAiTwinAuthToken({
  userId: 'user-123',
  userName: 'Jane',
});
// Pass authToken to <AiTwin /> — never expose Client-Secret to the browser.
```

Env: `AITWIN_CLIENT_ID`, `AITWIN_CLIENT_SECRET` (optional override:
`AITWIN_AUTH_TOKEN_URL`).

## Example

See `examples/src/aitwin_avatar.ts` in this repository.
