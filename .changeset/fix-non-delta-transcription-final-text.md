---
'@livekit/agents': patch
---

Fix `ParticipantTranscriptionOutput` non-delta final-stream publishing two
races that surfaced with Deepgram-style mid-utterance final bursts.

1. `handleFlush()` previously read `this.latestText` from inside
   `flushTaskImpl`, so a `captureText()` for the next segment landing
   before the flush task ran would overwrite the field and cause segment
   A's `lk.transcription_final: "true"` stream to publish segment B's
   text. The text to flush is now snapshotted when the task is scheduled
   and passed in as a parameter.

2. When the first event for a fresh segment was already `is_final`,
   `handleCaptureText` called `resetState()` after `captureText` had set
   `latestText`, clearing it back to `""`. The subsequent final stream
   then published an empty string. `latestText` is now restored from the
   captured payload immediately after `resetState()` so the same-tick
   final preserves the captured text.
