---
'@livekit/agents': patch
---

Port the barge-in cooldown / `backchannelBoundary` interruption window from Python (livekit/agents#5269). When the agent starts speaking, VAD-based interruption now stays active for a configurable cooldown (default `1000` ms) before being disabled, allowing the user to quickly correct themselves at the start of the agent's turn. When the agent finishes speaking, transcripts whose end time falls within the trailing cooldown (default `3500` ms) are released as normal user input instead of being held, surfacing premature answers to the agent's last sentence. The cooldown is configured via `turnHandling.interruption.backchannelBoundary` (a single number applies to both sides; pass `[start, end]` to configure them separately, or `null` to disable).
