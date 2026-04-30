---
"@livekit/agents": patch
---

feat(endpointing): expose dynamic endpointing alpha parameter

Adds `alpha` (EMA coefficient) to `EndpointingOptions` so callers can
configure dynamic endpointing smoothing through `turnHandling.endpointing`.
Default is `0.9`, matching Python parity (livekit/agents#5491).
