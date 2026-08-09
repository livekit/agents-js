---
'@livekit/agents': patch
---

Fix `ParticipantTranscriptionOutput` publishing wrong or empty text on the non-delta
final stream.

Preserve a segment's first captured text when initializing its state, and snapshot the
text when queuing a flush so a subsequent segment cannot replace the pending final
transcription.
