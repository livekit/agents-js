---
'@livekit/agents': patch
---

Add expressive mode: `AgentSession({ expressive: true })` injects the TTS provider's markup guide into the LLM prompt so the model emits inline `<expr/>` delivery markers (emotion, pacing, non-verbal sounds). The markers are lowered to each provider's native syntax before synthesis (Cartesia, Inworld TTS 2, xAI, Fish Audio) and stripped from transcripts, with the segment's leading expression surfaced as the `lk.expression` transcription attribute. Steer delivery with `ExpressiveOptions.speechSteering` or override the injected prompt entirely.
