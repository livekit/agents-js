---
'@livekit/agents-plugin-elevenlabs': patch
---

Add Scribe v3 models, configurable realtime commit strategies, and guarded Scribe v3 Live turn prediction.

Close fresh turns opened by uncommitted partials after local VAD silence so a phantom partial cannot pause an agent reply indefinitely.

End any open speech turn before reconnecting so the next partial can start a fresh turn.
