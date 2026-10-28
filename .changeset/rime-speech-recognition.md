---
'@livekit/agents-plugin-rime': minor
'@livekit/agents': patch
'@livekit/agents-plugin-silero': patch
---

Add optional Rime SDK speech recognition with unary requests and VAD-segmented native streaming, both transcript contracts, session keyterms, bounded concurrent uploads, and speech-ordered event publication. Preserve TTS-only installations without the optional SDK or its Node.js requirement.

Settle VAD input/output on EOF and cancellation, await Silero inference on close, close deferred STT/VAD input readers during shutdown, and finish StreamAdapter output after recognition completes.
