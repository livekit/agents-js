---
'@livekit/agents': patch
---

Keep the space before `Jr.`, `Inc.` and single-letter abbreviations in the basic sentence tokenizer, so `King Jr.` no longer becomes `KingJr.` and streamed sentences no longer start with a stray period.
