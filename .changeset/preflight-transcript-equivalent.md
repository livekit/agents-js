---
'@livekit/agents': patch
---

Keep the in-flight preemptive generation when a new preflight or final transcript differs from it only in casing or punctuation, instead of cancelling it and starting a new LLM request.
