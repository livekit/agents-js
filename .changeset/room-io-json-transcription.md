---
"@livekit/agents": patch
---

feat(room-io): add `jsonFormat` option on `RoomOutputOptions` for timed transcription output. When enabled, each chunk published on the `lk.transcription` datastream topic is a JSON object with `text`, and `start_time`/`end_time` when the chunk is a `TimedString`. Ported from livekit/agents#5472.
