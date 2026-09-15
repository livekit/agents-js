---
'@livekit/agents': patch
---

One `agent_turn` span per speech handle: the follow-up generation after a tool call continues the open span instead of opening a second turn, each generation is a `generation` event with `lk.generation_count` on the span, the turn ends with the speech, and a discarded preemptive generation hands its turn to the reply that answered.
