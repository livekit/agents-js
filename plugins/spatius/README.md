<!--
SPDX-FileCopyrightText: 2026 LiveKit, Inc.

SPDX-License-Identifier: Apache-2.0
-->

# Spatius plugin for LiveKit Agents

Connect a LiveKit voice agent to a [Spatius](https://spatius.ai) avatar using
[`@spatius/server-sdk`](https://github.com/spatius-ai/spatius-sdk-js).
The agent generates speech normally; Spatius publishes synchronized avatar tracks
into the same LiveKit room. Requires **Node.js 22 or newer**.

```sh
pnpm add @livekit/agents-plugin-spatius
```

Set `SPATIUS_API_KEY`, `SPATIUS_APP_ID`, `SPATIUS_AVATAR_ID`, and
`LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`.

```typescript
import * as spatius from '@livekit/agents-plugin-spatius';

// Connect the room, then attach the avatar BEFORE AgentSession.start().
await ctx.connect();
const avatar = new spatius.AvatarSession();
await avatar.start(session, ctx.room);
await session.start({ agent, room: ctx.room });
```

See `examples/src/spatius_avatar.ts` for a complete CLI entrypoint.

## Configuration

Credentials may be passed as `apiKey`, `appId`, and `avatarId` constructor options.
`start()` accepts `livekitUrl`, `livekitApiKey`, `livekitApiSecret`, and
`livekitRoomName` overrides. Otherwise the room name comes from the connected room.

- Audio defaults to **Ogg Opus**, with the SDK encoding mono PCM using its bundled
  WASM encoder (20 ms frames, `audio` application). No system Opus library is needed.
- The sample rate defaults to the session TTS rate, or 24 kHz for a realtime model.
  Opus accepts 8, 12, 16, 24, or 48 kHz. Set `sampleRate: 24000` to have the Agents
  pipeline resample a TTS provider with another rate.
- Select `audioFormat: spatius.AudioFormat.PCM_S16LE` or
  `SPATIUS_AUDIO_FORMAT=pcm_s16le` for raw PCM transport. Direct audio-output callers
  must supply mono frames at the configured rate.
- `region` / `SPATIUS_REGION` defaults to `auto`. Endpoint overrides use
  `consoleEndpointUrl` / `SPATIUS_CONSOLE_ENDPOINT` and
  `ingressEndpointUrl` / `SPATIUS_INGRESS_ENDPOINT`.
- `extraParams` forwards string-valued Spatius session parameters.
- `idleTimeout` and `opusFrameDuration` are in **milliseconds**. `idleTimeout`
  defaults to zero (disabled); `bitrate` is in bits per second, with zero meaning auto.
- Participant identity and name default to `spatius-avatar-agent`. Override with
  `avatarParticipantIdentity` and `avatarParticipantName`.

Use `prewarm: spatius.prewarm` in `defineAgent` to resolve the region and prefetch
a reusable session token in the job process. It reads the same environment
variables as `AvatarSession`; failures never prevent worker startup. Disable
token prefetch for single-use tokens:

```typescript
prewarm: (proc) => spatius.prewarm(proc, { prefetchSessionToken: false })
```

## Playback and lifecycle

The plugin mints a one-hour, room-scoped LiveKit agent token rather than sending
your LiveKit API secret to Spatius. The worker reports playback using
`lk.playback_started` and `lk.playback_finished`; only RPCs from the configured
avatar identity are accepted. Finished payloads contain `playback_position`
(seconds) and `interrupted` (boolean).

Interruptions discard queued speech and call the SDK's `interrupt()`. If the
worker does not acknowledge within two seconds, interrupted playout is released
locally. Like the Python plugin, these RPCs have no segment IDs, so notifications
must arrive in order; late notifications after the fallback cannot be correlated
to their original requests.

Job shutdown, agent-session closure, transport closure, and audio-send failure
release pending playout and close the SDK. Outside a job context, call
`await avatar.aclose()` in your application's `finally` block. Sessions cannot
be restarted; construct another `AvatarSession` for a new connection.
