---
'@livekit/agents': patch
'@livekit/agents-plugin-google': patch
---

Add the `gemini-3.8-flash-tts` and `gemini-3.8-flash-lite-tts` models to Gemini TTS, with expressive mode support. Delivery markers become per-part `speech_metadata.style`, while sounds, pauses and emphasis lower to Gemini's inline tags. The 3.8 models also accept multi-speaker configs (`speakers` + `speaker`). Expressive mode now works for any non-streaming TTS that declares a markup dialect, since `tts.StreamAdapter` lowers the markup. Transcript stripping also no longer leaves a stray space where a marker opened a turn or line, or closed the turn.
