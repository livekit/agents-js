# CLAUDE.md

Word-by-word transcript synchronization with audio playback. Ensures text is revealed in real-time sync with TTS audio rather than appearing all at once.

## Key Classes

- **TranscriptionSynchronizer** — Public API. Wraps audio and text outputs with `SyncedAudioOutput` and `SyncedTextOutput`. Manages segment rotation on playback completion, agent changes, or sync toggle.
- **SegmentSynchronizerImpl** — Internal state machine for one audio-text segment. Runs two concurrent tasks: `mainTask()` for sync timing and `captureTaskImpl()` for forwarding output.
- **SpeakingRateData** — Timing calculator. Accumulates word-level annotations from TTS or falls back to rate-based estimation. Uses binary search + linear interpolation via `accumulateTo(timestamp)`.

## Sync Modes

- **Annotation-based** (preferred): Uses word-level `TimedString` from TTS providers (`startTime`/`endTime`). More accurate.
- **Rate-based fallback**: Estimates timing using hyphens-per-second (`STANDARD_SPEECH_RATE = 3.83`) when no annotations available.

## Non-Obvious Patterns

- **Wall-clock timing**: Sync starts from first audio frame via `Date.now()`. No sample-level accuracy needed — just wall-clock relative delays.
- **Segment rotation**: Clean state boundaries between utterances. Old segment closed, new one created on playback finish, agent change, or sync toggle.
- **`barrier()` pattern**: Prevents race conditions — async callers wait for pending segment rotations to complete before proceeding.
- **Interrupted vs complete**: On playback completion, `synchronizedTranscript` returns full pushed text. On interruption, returns only text synced to that point.
- **Transparent passthrough when disabled**: If `enabled: false`, `SyncedTextOutput` strips `TimedString` wrappers and passes plain strings. `SyncedAudioOutput` skips synchronizer entirely.
- **Time units in seconds**: Unlike the rest of the codebase (ms), timing values inside `synchronizer.ts` are in **seconds** to match TTS provider annotations.
