---
'@livekit/agents': patch
'@livekit/agents-plugin-livekit': patch
'@livekit/agents-plugin-google': patch
'@livekit/agents-plugin-openai': patch
---

`JobRequest.accept()` now resolves after the assignment is received and the job is launched, and a pending assignment times out with `AssignmentTimeoutError` instead of hanging. The turn detector settles its language table with an error when `languages.json` is missing from the cache, so language lookups fail instead of waiting forever. The Google and OpenAI realtime `close()` await the base class cleanup.
