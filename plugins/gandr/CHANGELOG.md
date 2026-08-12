# @livekit/agents-plugin-gandr

## 1.6.2

### Patch Changes

- Initial release. Gandr TTS for LiveKit Node Agents: speaks the OpenAI-compatible
  `POST /v1/audio/speech` endpoint at `https://tts.gandr.ai/v1`, maps
  `voice`/`response_format`/`speed`, and raises the framework `APIError`
  subclasses on failure.
