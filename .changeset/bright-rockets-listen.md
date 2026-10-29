---
'@livekit/agents': patch
'@livekit/agents-plugin-openai': patch
'@livekit/agents-plugin-xai': patch
---

Align xAI Realtime voice defaults, add native scripted speech support, emit interim and one final user transcript per turn, and settle rejected realtime chat context updates.

Bring realtime error handling to parity with the Python plugin: treat fatal codes (quota / auth / billing) as non-recoverable when they arrive on a failed `response.done`, break the receive loop on them instead of reconnecting, and stop reporting `input_audio_buffer_commit_empty` as an error when server turn detection is enabled.
