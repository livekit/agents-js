---
'@livekit/agents-plugin-deepgram': patch
---

Keep streaming audio to Deepgram while an utterance is in progress

`AudioEnergyFilter` could stop forwarding frames after Deepgram had reported speech but before it had endpointed the utterance. Deepgram only fires `endpointing` on silence it actually receives, so once starved it never sent `speech_final`, no final transcript arrived, and the turn was never committed. `SpeechStream` now bypasses the energy gate between start of speech and endpoint, and clears that state when a websocket session starts so a reconnect cannot inherit an unfinished utterance.
