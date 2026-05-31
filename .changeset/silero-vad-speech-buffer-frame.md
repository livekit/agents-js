---
"@livekit/agents-plugin-silero": patch
---

Fix VAD speech buffer AudioFrame to include the prefix-padding pre-roll so START_OF_SPEECH / END_OF_SPEECH events deliver the full pre-rolled audio to downstream consumers (STT, transcription) and `samplesPerChannel` matches the data length.
