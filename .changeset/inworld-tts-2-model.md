---
"@livekit/agents-plugin-inworld": patch
"@livekit/agents": patch
---

Add support for the new `inworld-tts-2` Inworld TTS model.

- Adds `inworld/inworld-tts-2` to the `InworldModels` union exported from
  `@livekit/agents/inference` so the model is selectable when using the
  LiveKit Inference Gateway TTS client.
- Exports a new `TTSModels` type from `@livekit/agents-plugin-inworld`
  (`'inworld-tts-2' | 'inworld-tts-1.5-max'`) and updates `TTSOptions.model`
  to `TTSModels | string`, mirroring the Python plugin so callers get
  autocomplete for the curated model names while still being able to pass
  any custom model id.

Ports https://github.com/livekit/agents/pull/5646 from `livekit/agents`.
