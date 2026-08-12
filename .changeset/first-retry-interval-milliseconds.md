---
'@livekit/agents': patch
---

fix: wait 100ms before the first retry, not 0.1ms

`intervalForRetry` returned `0.1` for the first retry — Python's 0.1 _seconds_, carried over
without converting to the milliseconds every caller passes to `setTimeout`/`delay`. Its other
branch returns `retryIntervalMs`, so the two return paths were in different units. Measured,
the first retry waited ~3ms (scheduling overhead alone) against Python's 100ms.

This affects every retrying component — LLM, STT, TTS, avatars, and the turn-detector
transport — where a first retry reattempted essentially instantly.
