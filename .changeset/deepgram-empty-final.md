---
'@livekit/agents-plugin-deepgram': patch
---

Pass on an empty final result when it closes a segment whose interim had words, so `commitInterimOnEmptyFinal` can keep them. Empty finals with no interim to retract, such as silence, are still dropped.
