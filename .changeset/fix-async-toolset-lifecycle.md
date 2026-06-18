---
'@livekit/agents': patch
---

Fix two toolset lifecycle bugs:

- `AsyncToolset.create()` now honors the `setup`/`aclose` hooks it inherits from `ToolsetCreateOptions`. Previously the constructor discarded them, so a custom `setup`/`aclose` on an `AsyncToolset` was silently ignored. The provided `aclose` now runs in addition to the executor drain/close.
- `AgentSession` close now tears down the flattened set of session toolsets (including nested toolsets) to mirror `AgentActivity.setupToolsets()`. Previously only top-level session toolsets were closed, leaking resources/listeners held by nested toolsets.
