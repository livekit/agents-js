---
'@livekit/agents': patch
---

feat(agents): add modality-aware `Instructions` with audio/text variants

Introduce a new `Instructions` class for system prompts that adapt to the
user's input modality. The pipeline now applies the matching variant before
each LLM turn based on `SpeechHandle.inputDetails.modality`, and
`AgentSession.generateReply()` exposes an `inputModality` option.
