---
'@livekit/agents': patch
---

fix(voice): release an agent's pooled TTS connections on handoff when the next agent uses a different TTS instance, instead of holding them open until the job ends. Adds `TTS.release()`, a no-op by default, implemented by the inference TTS.
