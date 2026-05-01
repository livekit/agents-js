---
'@livekit/agents': patch
---

Port AMD improvements from python `livekit/agents#5584`. `voice.AMD` now exposes the previously hard-coded timing thresholds (`humanSpeechThresholdMs`, `humanSilenceThresholdMs`, `machineSilenceThresholdMs`) and the classification `prompt` as constructor options, defers to the LLM (instead of forcing a HUMAN verdict) when a transcript is already available after a short greeting, and accepts a `participantIdentity` hint plus a `suppressCompatibilityWarning` flag. The classifier now offers two LLM tools — `save_prediction` and `postpone_termination` (capped at 3 extensions × 10s) — letting the model request more audio when the transcript is ambiguous; if the model returns plain JSON instead of tool calls, AMD falls back to the previous content-parsing path. AMD also logs a one-shot warning when the resolved LLM is not in the bundled `EVALUATED_LLM_MODELS` list.
