---
"@livekit/agents": patch
"@livekit/agents-plugin-cartesia": patch
"@livekit/agents-plugin-deepgram": patch
"@livekit/agents-plugin-elevenlabs": patch
"@livekit/agents-plugin-neuphonic": patch
---

Fix race condition where STT/TTS processing could throw "Queue is closed" error when a participant disconnects. These events are now logged as warnings instead of errors.
