---
'@livekit/agents': patch
---

Add DuplexModel and DuplexSession for full-duplex speech providers. Agent and AgentSession accept duplex models through an adapter that segments continuous audio and aligns transcripts. Preserve overlapping speech and collect usage reported during realtime session shutdown.
