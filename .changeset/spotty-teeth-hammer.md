---
'@livekit/agents': patch
---

fix(voice): don't commit unspoken text when a reply is interrupted before the transcript synchronizer released any words — an empty (but defined) synchronizedTranscript now means nothing was heard, instead of falling back to the full generated text
