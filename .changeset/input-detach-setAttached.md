---
'@livekit/agents': patch
---

Keep audio input mute independent of overridable attach hooks

`AgentInput` now flips mute via `AudioInput.setAttached()` before calling `onAttached`/`onDetached`, and `ParticipantAudioInputStream` gates on that state. Subclasses that override lifecycle hooks without `super` no longer silently break hold mute.
