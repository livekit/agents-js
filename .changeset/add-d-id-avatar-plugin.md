---
'@livekit/agents-plugin-did': minor
---

Add D-ID avatar plugin. Mirrors the Python `livekit-plugins-did` package: dispatches a D-ID v4 (expressive) avatar worker into a LiveKit room via the `POST /v2/agents/{agent_id}/sessions/join` API, wires the agent's audio output to a `voice.DataStreamAudioOutput` targeting the avatar participant, and supports configurable audio sample rate (16000 / 24000 / 48000).
