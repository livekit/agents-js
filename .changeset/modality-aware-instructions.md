---
'@livekit/agents': patch
---

feat(agents): add modality-aware `Instructions` with audio/text variants

Introduce a new `Instructions` class for system prompts that adapt to the
user's input modality. The pipeline now applies the matching variant before
each LLM turn based on `SpeechHandle.inputDetails.modality`, and
`AgentSession.generateReply()` and `AgentSession.run()` expose an
`inputModality` option. `Instructions.tpl` supports JS-native prompt
composition while preserving audio/text variants.
