---
'@livekit/agents': patch
---

Keep the space before `Jr.`, `Inc.` and single-letter abbreviations in the basic sentence tokenizer, so `King Jr.` no longer becomes `KingJr.`, and keep the period when such an abbreviation ends a sentence (`Acme Inc. They`). Streamed sentences no longer start with a stray period.
