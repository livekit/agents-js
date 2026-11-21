---
'@livekit/agents-plugin-phonic': patch
---

Add a `modalities` option to the Phonic `RealtimeModel`. Set it to `['text']` for a text conversation: typed user turns go to Phonic as user messages and replies stream as text with no audio.
