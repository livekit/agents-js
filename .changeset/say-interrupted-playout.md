---
'@livekit/agents': patch
---

Skip the assistant message when an interrupted `say()` speech never played. When playback started, use the synchronized transcript if available.

Keep captions already sent to the text output in the synchronized transcript when speech is interrupted.
