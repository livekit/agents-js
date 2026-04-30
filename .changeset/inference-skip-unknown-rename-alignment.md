---
"@livekit/agents": patch
---

Port livekit/agents#5614:

- **fix(inference/tts): rename `output_timestamps` server event to `output_alignment`** — matches the gateway's renamed message type. The schema literal, `ttsKnownServerEventSchema` discriminated union, the `knownTtsServerEventTypes` set, the recv-loop `switch` case, and the test fixtures all switch from `output_timestamps` to `output_alignment`. The exported type alias `TtsOutputTimestampsEvent` is renamed to `TtsOutputAlignmentEvent` (the previous name was internal — it was not surfaced in the public API extractor report and was not referenced by any plugin or example).
- **fix(inference/stt, inference/tts): silently drop unknown / unparseable server events** — drops the `"Unexpected message from LiveKit TTS"` and `"Failed to parse STT server event"` `logger.warn` calls in the recv loops so they no longer flood logs when the inference gateway introduces new event types. Behavior matches the Python change in `inference/stt.py` and `inference/tts.py`.
