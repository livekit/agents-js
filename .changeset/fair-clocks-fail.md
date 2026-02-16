---
'@livekit/agents-plugin-sarvam': patch
---

Add explicit `streaming` preference toggles for Sarvam STT and TTS so users can choose REST/non-streaming behavior over native WebSocket streaming. Also make local toggle tests runnable without a real `SARVAM_API_KEY` by gating integration coverage and using dummy-key unit tests.
