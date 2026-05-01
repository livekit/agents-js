---
'@livekit/agents-plugin-liveavatar': patch
'@livekit/agents': patch
---

Port the `liveavatar` plugin from the Python `livekit-agents` repo, including the new `videoQuality` parameter from livekit/agents#5552.

The new `@livekit/agents-plugin-liveavatar` package adds a LiveAvatar `AvatarSession` that mirrors the Python plugin: it brings up a LiveAvatar streaming session, opens the realtime websocket, captures the agent's audio output through a queue-based `AudioOutput`, resamples to 24 kHz mono, and forwards base64-encoded chunks (~600 ms first chunk, ~1 s subsequent) to the LiveAvatar service. Inbound websocket events drive playback start/finish notifications back into the `AgentSession`.

Also exports `voice.AudioOutput` (and its companion `AudioOutputCapabilities` / `PlaybackFinishedEvent` / `PlaybackStartedEvent` types) from `@livekit/agents` so plugin authors can subclass the abstract audio sink.
