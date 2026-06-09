---
'@livekit/agents-plugin-did': patch
---

feat(d-id): add D-ID avatar plugin

Dispatches a D-ID v4 (expressive) avatar worker into a LiveKit room via `POST /v2/agents/{agent_id}/sessions/join` and routes the agent's audio to it through `voice.DataStreamAudioOutput`. Audio sample rate is configurable (16k / 24k / 48k, default 24k) via `AudioConfig`. See `examples/src/did_avatar.ts` for usage.
