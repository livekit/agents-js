---
'@livekit/agents': patch
---

Make `ToolOptions.abortSignal` required. The framework always provides an `AbortSignal` to tool execution, so the field is no longer optional. Tool authors can rely on `abortSignal` always being defined and drop defensive `if (abortSignal)` checks.
