---
'@livekit/agents': patch
---

Commit held final transcripts as one user turn when they replay after agent speech. Previously, a session without a turn detector could commit the first transcript early and add the user's speech twice.
