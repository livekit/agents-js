---
'@livekit/agents-plugin-deepgram': patch
---

Pass on an empty final result when the connection's latest interim had words and no final or `UtteranceEnd` has closed it, so `commitInterimOnEmptyFinal` can keep them. Other empty finals, such as silence, are still dropped.
