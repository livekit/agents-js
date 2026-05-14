---
'@livekit/agents-plugin-elevenlabs': patch
---

refactor(elevenlabs): abort the TTS recv channel on websocket close/error instead of holding the error in a Future
