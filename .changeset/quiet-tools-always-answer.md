---
'@livekit/agents': patch
'@livekit/agents-plugin-google': patch
'@livekit/agents-plugin-phonic': patch
---

Answer every completed tool call, including interrupted, silent, and invalid calls, and keep realtime providers quiet when supported. A tool can return a handoff inside a list, and a handoff batched with another tool now applies even when that tool finishes last.
