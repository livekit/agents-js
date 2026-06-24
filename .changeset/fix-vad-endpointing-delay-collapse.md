---
'@livekit/agents': patch
---

Fix `minEndpointingDelay` being silently ignored in VAD-based turn
detection. `bounceEOUTask` runs at VAD `END_OF_SPEECH`, which Silero
emits `minSilenceDuration` (~550 ms) after the user stops, but the
post-EOS delay was computed as
`extraSleep = endpointingDelay + (lastSpeakingTime - Date.now())`,
collapsing the grouping window to `~max(minSilenceDuration, minDelay)`
and committing the turn the instant `END_OF_SPEECH` fired. With the
default `minDelay = 500` and `minSilenceDuration = 550`, the effective
post-EOS window was `~−50 ms` — so a natural mid-sentence pause (and
even silences shorter than the configured min delay) split into two
segments. With realtime models using manual activity detection, the
second segment's `userTurnCompleted` never fires and the agent never
responds (#1741).

Skip the elapsed-since-speech adjustment in VAD mode so `minDelay`
provides a real post-EOS grouping window that an upcoming
`START_OF_SPEECH` can cancel. STT mode keeps the adjustment — there the
adjustment correctly compensates for transcription latency, and a new
regression test guards that path.
