---
'@livekit/agents': patch
---

fix(voice): clear stale paused-speech state across generation steps

Ports livekit/agents#5594. Resets `pausedSpeech`, the false-interruption
timer, and the paused audio output at the scheduling-loop boundary in
`AgentActivity` after each generation step finishes, so paused state
captured during an earlier silent step (e.g. a silent tool call) does not
leak into the next step on the same `SpeechHandle` (e.g. the tool reply).
