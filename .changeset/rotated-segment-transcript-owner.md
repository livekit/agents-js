---
'@livekit/agents': patch
---

Stop an interrupted reply from committing a previous segment's synchronized transcript when its
playout wait resolves on that segment's finish, which recorded the previous reply as a phantom
repeat in chat context.
