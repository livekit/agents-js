---
"@livekit/agents-plugin-openai": patch
---

feat(plugin-openai): stream `input_audio_transcription.delta` events on the OpenAI Realtime API as `UserInputTranscribed` partials (`isFinal: false`). Enables word-by-word user transcripts with `gpt-realtime-whisper` and any future delta-emitting transcription model. Accumulators are cleared on `.completed`, `.failed`, `conversation.item.deleted`, session close, and reconnect; `.failed` now emits a closing `isFinal: true` event when partials had streamed so consumers don't hang.
