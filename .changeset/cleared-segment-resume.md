---
'@livekit/agents': patch
---

Stop the transcript of an interrupted speech at the cut. Before, when a paused speech was interrupted and the audio output resumed, the transcription synchronizer kept releasing words of that speech until its playback finished, although its audio was cleared.
