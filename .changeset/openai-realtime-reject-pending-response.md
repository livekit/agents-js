---
'@livekit/agents-plugin-openai': patch
---

fix(openai realtime): reject pending response future on error event. When the OpenAI Realtime API returns an `error` event referencing the `event_id` of a `response.create` we issued, the corresponding future created by `generateReply()` is now rejected instead of left hanging. Ports livekit/agents#5576.
