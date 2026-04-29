---
"@livekit/agents": minor
---

feat(inference/tts): detect aligned transcript capability from provider `modelOptions` (`cartesia.add_timestamps`, `elevenlabs.sync_alignment`, `inworld.timestamp_type`) and forward the gateway's `output_timestamps` WebSocket events as `TimedString` word/character timings attached to the next synthesized audio frame. Ported from livekit/agents#5534.
