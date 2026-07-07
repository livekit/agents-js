---
'@livekit/agents': patch
---

Add session-scoped `mockTools(agent, mocks, session)` to `voice.testing`: assigns a mock set for an Agent type on a specific session, effective for the session's lifetime. Context-scoped `withMockTools` mocks take precedence when both are active.
