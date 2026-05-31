---
"@livekit/agents": patch
---

fix(inference): stop mislabeling barge-in handler errors as parse failures

The interruption WebSocket handler wrapped both `wsMessageSchema.parse` and `handleMessage` in one `try`, so a handler throw (e.g. a late `bargein_detected` prediction enqueued after the readable side was errored/closed) was logged as "Failed to parse WebSocket message" with the real error discarded. Parse and handler errors are now caught separately and log the actual error, and the late barge-in event is dropped quietly (`desiredSize === null`) instead of throwing into a dead stream.
