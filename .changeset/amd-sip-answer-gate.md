---
"@livekit/agents": patch
---

Defer AMD listening until the participant audio track is subscribed, and for SIP participants until `sip.callStatus` is `active`, so ringback and early media no longer consume the no-speech budget. After AMD settles on a machine verdict with `interruptOnMachine`, skip the normal auto-reply triggered by user-turn completion so it no longer races with — and interrupts — the caller's own `generateReply` (e.g. leaving a voicemail).

Complete the AMD verdict-emission port: add `waitUntilFinished` and `maxEndpointingDelayMs` options and gate emission on both post-speech silence and end-of-turn (machine/uncertain verdicts wait for the turn detector or a fallback backstop; a confident human releases on silence alone). Settle `no_speech_timeout` as `uncertain` instead of `machine-unavailable`. Treat the classifier LLM's tool calls as authoritative — no longer resurrect a verdict by parsing free-text content emitted alongside an `uncertain`/postpone tool call.

Wire AMD into the recognition-hook layer the way the Python framework does: `AgentActivity` now drives AMD via `onUserSpeechStarted()`, `onUserSpeechEnded(silenceDurationMs)`, and `onTranscript(text, source)` from its VAD/STT hooks, instead of AMD snooping the derived `UserStateChanged`/`UserInputTranscribed` session events. This gives AMD the VAD's real `silenceDuration` directly, so post-speech timers and reported delays are anchored on the true speech-end time rather than skewed by VAD/event latency.

Port the AMD classification prompt verbatim from the Python framework — restoring the task description, category definitions (`machine-vm` = leaving a message IS possible; `machine-unavailable` = NOT possible), and the few-shot examples that steer borderline cases (hours-of-operation → uncertain, "press 1" → machine-ivr, call-screening → machine-ivr) — and pass the raw transcript as the user message so it matches the prompt's `Input:`/`Output:` pattern.
