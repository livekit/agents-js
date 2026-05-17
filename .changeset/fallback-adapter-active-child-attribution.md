---
'@livekit/agents': patch
---

fix(stt): reflect active child in `FallbackAdapter` `model`/`provider`

`audio_recognition.refreshUserTurnSttAttributes` reads these on every
STT event to stamp `gen_ai.request.model` / `gen_ai.provider.name`
on the `user_turn` span. With static wrapper labels, every span
reported `FallbackAdapter` / `livekit` regardless of which provider
actually transcribed — so a mid-turn fallover was invisible in
traces. Track the elected child from both the streaming and
recognize paths and surface its identifiers.
